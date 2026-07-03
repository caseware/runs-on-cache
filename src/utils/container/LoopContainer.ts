/**
 * LoopContainer — fs-agnostic orchestrator for loop-image-backed cache entries.
 *
 * Holds ALL orchestration shared by BtrfsContainer and XfsContainer: bind
 * mounts (workspace ↔ image paths), the node-local restore hot path, the
 * copy + UUID-randomize WORM flow, mount discovery (parameterized by fs type),
 * unmountAll, cleanStaleMounts, findExisting<Fs>Mount, and path-traversal
 * checks. Delegates image lifecycle to a LoopImage subclass.
 *
 * Subclasses (BtrfsContainer / XfsContainer) supply only their genuine
 * differences via the protected hooks below: the concrete image instance,
 * node-local extension, isSupportedMethod, log prefix, findmnt fs-type, the
 * local-copy filename, and the raw↔archive transform hooks (no-op for btrfs,
 * zstd compress/decompress for xfs).
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createCacheKeySpecificTempDirectory } from "../actionUtils";
import { Container, ContainerOptions } from "./Container";
import { Ext4UpperImage } from "./Ext4UpperImage";
import { LoopImage } from "./LoopImage";

export abstract class LoopContainer extends Container {
    public requiresCreateEmptyCache = true;
    public requiresKeepArchive = true;

    protected mountPoint: string | undefined;
    protected readonly fsSize: string;
    protected readonly mountMode: "ro" | "rw";

    /**
     * Path to the (uncompressed) image that is actually loop-mounted.
     * For btrfs this is always kept in sync with containerFile. For xfs it is a
     * distinct raw working file (containerFile holds the compressed artifact).
     */
    protected rawImageFile: string;

    /** Set to true if save verification fails. */
    protected saveAborted = false;
    /**
     * True once a consumer overlay has been fast-dropped in save(). A consumer
     * overlay produces no archive artifact, so the caller must skip the S3
     * upload — otherwise it would stat/upload a non-existent archivePath.
     */
    protected overlayDropped = false;
    /** True if the current mount is read-only. */
    protected mountIsReadOnly = false;
    /**
     * True when the workspace is an overlayfs (RO WORM image lower + RW upper)
     * rather than a directly-mounted RW image — the no-copy node-local fast
     * path. The overlay is teardown-only (consumer never saves back), and the
     * lower RO image mount must be unmounted alongside the overlay.
     */
    protected usingOverlay = false;
    /** The RO lower-layer mount point of an active overlay (for teardown). */
    protected overlayLowerMount: string | undefined;
    /**
     * The overlay upper+work base dir, placed on the NON-overlay node-local fs
     * (not $RUNNER_TEMP, which is overlayfs on k8s). Removed on teardown so the
     * node-local dir doesn't accumulate per-job RW deltas.
     */
    protected overlayBaseDir: string | undefined;
    /**
     * When set, the overlay upper+work live on a DEDICATED per-job ext4 loop
     * image mounted at overlayBaseDir (not a plain dir on the shared node-local
     * fs). Teardown is then O(1): unmount the image + delete this one backing
     * file frees all upper inodes with the filesystem, instead of unlink()ing
     * the (up to ~700k) copied-up workspace files one by one on the runner's
     * critical path. Undefined => plain-dir upper fallback (slower teardown).
     */
    protected overlayUpperImageFile: string | undefined;
    /**
     * The Ext4UpperImage instance for an active image-backed overlay upper
     * (holds the attached loop device for detach at teardown). Undefined for a
     * plain-dir upper, or in the SAVE process before re-detection.
     */
    protected overlayUpperImage: Ext4UpperImage | undefined;
    /** Per-run temp dir used as CWD for all exec calls. */
    protected safeCwd = "";

    constructor(
        containerFile: string,
        compressionMethod: string,
        compressionLevel: string | undefined,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerOptions
    ) {
        super(
            containerFile,
            compressionMethod,
            compressionLevel,
            baseDir,
            pathsToCache,
            cacheKey,
            options
        );

        if (!options.fsSize) {
            throw new Error(
                `fsSize option is required for ${this.constructor.name}`
            );
        }

        this.fsSize = options.fsSize;
        this.mountMode = options.mountMode || "rw";
        this.rawImageFile = containerFile;

        this.checkPathTraversal(this.baseDir, this.containerFile);
        this.pathsToCache.forEach(p =>
            this.checkPathTraversal(this.baseDir, p)
        );
    }

    // ── fs-specific hooks ─────────────────────────────────────────────

    /** The concrete image instance (created by the subclass constructor). */
    protected abstract get image(): LoopImage;
    /** Human-readable fs name, e.g. "BTRFS" | "XFS". */
    protected abstract get fsDisplayName(): string;
    /** Filesystem type passed to `findmnt -t`. */
    protected abstract findmntFsType(): string;
    /** Filename for the local RW copy of a WORM image, e.g. "cache.btrfs". */
    protected abstract localCopyName(): string;

    /**
     * Finalize the working-image path inside safeCwd during initialize().
     * btrfs mounts containerFile directly (no-op). xfs builds at a raw path so
     * the artifact path is free to hold compressed bytes.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    protected async setupRawImagePath(): Promise<void> {}

    /**
     * Prepare rawImageFile to be mountable for an S3-download restore.
     * btrfs: rawImageFile already === containerFile (no-op). xfs: decompress
     * the compressed artifact at containerFile into rawImageFile.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    protected async prepareRawForRestore(): Promise<void> {}

    /**
     * Produce the final S3 artifact from the verified raw image.
     * btrfs: the raw image IS the artifact (no-op). xfs: zstd-compress
     * rawImageFile into containerFile.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    protected async finalizeSaveArtifact(): Promise<void> {}

    /** Extra files to remove when a save is skipped (e.g. xfs raw image). */
    protected extraStaleFiles(): string[] {
        return [];
    }

    /**
     * Called from discoverMountInfo() once the live mount is found, with the
     * mount SOURCE (the loop device, e.g. "/dev/loop5"). The save step runs in a
     * SEPARATE process from restore/createEmptyCache, so its per-run mkdtemp
     * safeCwd — and therefore the default rawImageFile / image path computed in
     * setupRawImagePath() — does NOT point at the image that is actually mounted.
     * btrfs is immune (it mounts the stable containerFile path directly), so the
     * default is a no-op. xfs overrides this to resolve the real backing file
     * from the loop device and re-point rawImageFile / the image at it, so
     * verifyMountable() and finalizeSaveArtifact() operate on the file that
     * actually exists. See XfsContainer.onMountDiscovered.
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-function,@typescript-eslint/no-unused-vars
    protected async onMountDiscovered(source: string): Promise<void> {}

    /**
     * Whether the standard (non-node-local) RW restore must copy+UUID-randomize
     * before mounting. btrfs does this when containerFile is in the node-local
     * WORM dir; xfs never (its raw image always lives in safeCwd).
     */
    protected shouldCopyOnRwRestore(): boolean {
        return false;
    }

    /**
     * Called after copyAndMountReadWrite produces a fresh local RW copy.
     * btrfs points containerFile at the copy (it uploads the raw image); xfs
     * keeps containerFile as the compressed-artifact target (no-op).
     */
    // eslint-disable-next-line @typescript-eslint/no-empty-function,@typescript-eslint/no-unused-vars
    protected onRawImageCopied(localCopy: string): void {}

    // ── lifecycle ─────────────────────────────────────────────────────

    async initialize(): Promise<void> {
        this.safeCwd = await fs.mkdtemp(
            path.join(os.tmpdir(), `${this.tmpPrefix()}-`)
        );
        this.image.setSafeCwd(this.safeCwd);

        await this.setupRawImagePath();

        try {
            await this.image.checkPrerequisites();
        } catch (e) {
            core.setFailed((e as Error).message);
            process.exit(1);
        }

        try {
            await this.nodeLocal.cleanupStaleTempFiles();
        } catch (e) {
            core.warning(
                `${this.getLogPrefix()} Stale temp cleanup failed (non-fatal): ${
                    (e as Error).message
                }`
            );
        }
    }

    /** Prefix for the per-run temp dir, e.g. "btrfs" | "xfs". */
    protected abstract tmpPrefix(): string;

    // ── Node-local restore (hot path) ────────────────────────────────

    async tryRestoreFromNodeLocal(restoreKeys?: string[]): Promise<boolean> {
        if (!this.nodeLocal.enabled) return false;

        // 1. Exact key match (fastest path)
        const localExists = await this.nodeLocal.exists();
        if (localExists) {
            const localPath = this.nodeLocal.localPath;
            this.logInfo(`Node-local exact hit — mounting from ${localPath}`);

            try {
                if (this.mountMode === "rw") {
                    await this.overlayMountReadWrite(localPath);
                } else {
                    await this.mountImageReadOnly(localPath);
                }
                this.restoredFromNodeLocal = true;
                this.restoreSource = (await this.nodeLocal.isPrewarmed(
                    localPath
                ))
                    ? "prewarmed"
                    : "node-local";
                return true;
            } catch (error) {
                core.warning(
                    `${this.getLogPrefix()} Node-local mount failed, falling back to S3: ${
                        error instanceof Error ? error.message : error
                    }`
                );
                return false;
            }
        }

        // 2. Partial match
        if (restoreKeys && restoreKeys.length > 0) {
            const closestMatch = await this.nodeLocal.findClosestMatch(
                restoreKeys
            );
            if (closestMatch) {
                try {
                    this.logInfo(
                        `Node-local partial hit — overlay RW on ${path.basename(
                            closestMatch
                        )} (no copy)`
                    );
                    await this.overlayMountReadWrite(closestMatch);
                    this.restoredFromNodeLocal = true;
                    this.restoreSource = (await this.nodeLocal.isPrewarmed(
                        closestMatch
                    ))
                        ? "prewarmed"
                        : "node-local";
                    return true;
                } catch (error) {
                    core.warning(
                        `${this.getLogPrefix()} Node-local partial mount failed, falling back to S3: ${
                            error instanceof Error ? error.message : error
                        }`
                    );
                    return false;
                }
            }
        }

        return false;
    }

    // ── Standard restore (S3 download path) ──────────────────────────

    async restore(): Promise<void> {
        try {
            await this.prepareRawForRestore();

            if (this.mountMode === "ro") {
                await this.mountImageReadOnly(this.rawImageFile);
            } else if (this.shouldCopyOnRwRestore()) {
                // The just-downloaded image was committed to the node-local WORM
                // dir (S3-miss path). Overlay-mount it RW instead of copying the
                // whole ~13.5 GB — same no-copy fast path as a node-local hit.
                // (A node-local restore never saves back, so an overlay is safe.)
                this.logInfo(
                    `Container file is in node-local WORM dir — overlay RW mount (no copy)`
                );
                await this.overlayMountReadWrite(this.rawImageFile);
            } else {
                this.image.setImageFile(this.rawImageFile);
                await this.mountImageReadWrite({ expandForHeadroom: true });
                await this.image.checkHealth(this.mountPoint!);
            }
        } catch (error) {
            await this.image.cleanupLoopDevices(this.rawImageFile);
            throw this.wrapError(`restore ${this.fsDisplayName} cache`, error);
        }
    }

    async createEmptyCache(): Promise<void> {
        try {
            this.image.setImageFile(this.rawImageFile);
            await this.image.createSparseImage(this.fsSize);
            return this.mountImageReadWrite();
        } catch (error) {
            await this.image.cleanupLoopDevices(this.rawImageFile);
            // Clean up the sparse file so the save step doesn't upload an
            // empty image to S3.
            try {
                await fs.unlink(this.rawImageFile);
                this.logInfo("Cleaned up sparse file after mount failure");
            } catch {
                /* file may not exist */
            }
            throw this.wrapError(
                `create empty ${this.fsDisplayName} cache`,
                error
            );
        }
    }

    async save(): Promise<void> {
        try {
            await this.discoverMountInfo();
        } catch {
            this.logInfo(
                `No ${this.fsDisplayName} mount found — skipping save`
            );
            // Delete any stale artifact / raw image so the S3 upload doesn't
            // pick up an empty image.
            for (const f of [this.containerFile, ...this.extraStaleFiles()]) {
                try {
                    await fs.unlink(f);
                } catch {
                    /* file may not exist */
                }
            }
            return;
        }

        if (!this.mountPoint) {
            this.logInfo("Mount point not discovered — skipping save");
            return;
        }

        if (this.usingOverlay) {
            this.logInfo(
                "Workspace is a consumer overlay on a node-local WORM image " +
                    "(nothing to persist to S3); dropping it O(1) instead of " +
                    "leaving the pod to reap the upper."
            );
            await this.dropOverlayFast();
            // No archive is produced for a consumer overlay; signal the caller
            // to skip the S3 upload (else it stats a non-existent archivePath).
            this.overlayDropped = true;
            return;
        }

        if (this.mountIsReadOnly) {
            this.logInfo(
                "Skipping save — mount is read-only, nothing to persist"
            );
            return;
        }

        // fs-specific prepare (btrfs: defrag/resize/truncate; xfs: sync)
        await this.image.prepareSave(this.mountPoint);

        // Unmount all bind mounts + main mount. Only a real unmount produces a
        // self-consistent on-disk image — freezing a still-mounted fs does NOT
        // (xfs_repair reports agi_freecount/sb_ifree mismatches and the kernel
        // hits finobt corruption → fs shutdown → EIO on restore), so unmount is
        // the ONLY save path.
        await this.unmountAll();

        // Verify image is mountable before upload
        const ok = await this.image.verifyMountable();
        if (!ok) {
            this.saveAborted = true;
            throw new Error(
                `${this.fsDisplayName} verification failed — aborting save to prevent cache poisoning`
            );
        }

        // fs-specific finalize (btrfs: no-op; xfs: zstd-compress to artifact).
        // For xfs this reads (does not consume) rawImageFile, so the raw image
        // survives for the read-only remount below.
        await this.finalizeSaveArtifact();

        this.logDebug(
            `Save completed. Artifact ready for upload: ${this.containerFile}`
        );

        // The image is now consistent on disk and the artifact is ready for
        // upload. The cache was bind-mounted on the GitHub workspace root, and
        // unmounting it leaves later composite POST-steps unable to re-read
        // local actions from the workspace. Remount the (just-unmounted,
        // consistent) raw image READ-ONLY and re-establish the workspace binds
        // so those files are present again. This is best-effort — the artifact
        // is already saved, so a remount failure must NOT fail the save.
        await this.remountReadOnlyForPostSteps();
    }

    /**
     * After a successful save (image unmounted + verified + artifact finalized),
     * remount the RAW image READ-ONLY at the workspace so later composite
     * POST-steps can still read local actions from `$GITHUB_WORKSPACE`.
     *
     * We mount the RAW image that was just verified (xfs: rawImageFile, which
     * survives finalizeSaveArtifact because zstd compression reads it without
     * removing it; btrfs: containerFile IS the raw image). We deliberately do
     * NOT mount the compressed artifact.
     *
     * A read-only mount can never corrupt the image, and the post-step cleanup
     * (BtrfsCleanup scopedCleanup, fs-agnostic) unmounts it at job end.
     *
     * FATAL on failure: leaving the workspace unmounted makes later composite
     * POST-steps (which re-read local ./.github/actions from $GITHUB_WORKSPACE)
     * fail with a confusing "Can't find action.yml" far from the cause.
     * Throwing here surfaces the real reason at the right place. The S3 artifact
     * is already uploaded, so this doesn't lose the cache — it correctly reports
     * that the required workspace remount did not happen.
     */
    protected async remountReadOnlyForPostSteps(): Promise<void> {
        this.logInfo(
            "Remounting saved image read-only so post-steps can read the workspace"
        );
        await this.mountImageReadOnly(this.rawImageFile);
        // mountImageReadOnly may set mountIsReadOnly=true (bind-to-existing
        // branch). That flag gates shouldSkipS3Upload(), which cache.ts
        // consults AFTER save() returns — a true here would wrongly skip the
        // upload of the artifact we just produced. The save already
        // succeeded and the image is consistent, so reset it.
        this.mountIsReadOnly = false;
    }

    shouldSkipS3Upload(): boolean {
        return this.mountIsReadOnly || this.saveAborted || this.overlayDropped;
    }

    // ── Private: mount orchestration ─────────────────────────────────

    protected async mountImageReadOnly(imageFile: string): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        this.mountPoint = path.join(tempDir, "mount");

        // Sync image path — imageFile may differ from the original raw path
        // (e.g. node-local path vs $RUNNER_TEMP path after S3 download).
        this.image.setImageFile(imageFile);

        await this.cleanStaleMounts();

        // For shared node-local WORM files, another runner on the same node
        // may already have a loop device + mount. Creating a second loop device
        // can trigger a UUID collision. Reuse the existing mount via bind mount.
        const existingMount = await this.findExistingMount(imageFile);
        if (existingMount) {
            this.logInfo(
                `Bind-mounting from existing mount: ${existingMount} → ${this.mountPoint}`
            );
            await fs.mkdir(this.mountPoint, { recursive: true });
            await exec.exec(
                "sudo",
                ["mount", "--bind", existingMount, this.mountPoint],
                { cwd: this.safeCwd, silent: !core.isDebug() }
            );
            this.mountIsReadOnly = true;
        } else {
            await this.image.mountRO(this.mountPoint);
        }

        try {
            await this.bindMountPaths(true);
        } catch (error) {
            await this.image.umountSafe(this.mountPoint);
            if (!existingMount) {
                await this.image.cleanupLoopDevices(imageFile);
            }
            this.mountPoint = undefined;
            throw error;
        }

        await this.image.checkHealth(this.mountPoint);
    }

    /**
     * Mount the working image read-write.
     *
     * When `expandForHeadroom` is set (restore paths — the saved image is tight
     * and the consumer needs room for checkout deltas, build artifacts, etc.),
     * the RW headroom grow is performed AROUND the single real mount:
     *
     *   1. Compute the headroom target and grow the BACKING FILE *before*
     *      mountRW. The fresh `losetup --find --show` inside mountRW then
     *      exposes the full device capacity from the start, so the (single)
     *      log recovery happens at full size.
     *   2. After mountRW, grow the FILESYSTEM onto the already-present backing
     *      space (xfs_growfs / btrfs resize).
     *
     * This deliberately avoids a live `losetup -c` capacity change on a
     * mounted, just-log-recovered device — that was the kernel-5.15 XFS finobt
     * corruption trigger (EFSCORRUPTED → fs shutdown → EIO on checkout's
     * unlink/rmdir) behind the warm-restore failures.
     *
     * createEmptyCache mounts a fresh sparse image and passes no options, so it
     * never expands here.
     */
    protected async mountImageReadWrite(
        opts: { expandForHeadroom?: boolean } = {}
    ): Promise<void> {
        try {
            const tempDir = await createCacheKeySpecificTempDirectory(
                this.cacheKey
            );
            this.mountPoint = path.join(tempDir, "mount");

            await this.cleanStaleMounts();

            // Grow the BACKING FILE before mounting (never `losetup -c` on a
            // live, recovered device). The fresh loop attach in mountRW exposes
            // the full size, so the post-mount filesystem grow is safe.
            let grew = false;
            if (opts.expandForHeadroom) {
                grew = await this.image.growBackingFileForHeadroom();
            }

            await this.image.mountRW(this.mountPoint);

            if (grew) {
                await this.image.growFilesystemForHeadroom(this.mountPoint);
            }

            await this.bindMountPaths(false);
        } catch (error) {
            await this.image.cleanupLoopDevices(this.image.getImageFile());
            throw new Error(
                `Failed to mount ${this.fsDisplayName} filesystem: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    /**
     * Mount a node-local WORM image for RW use WITHOUT copying the whole image.
     *
     * The previous approach (copyAndMountReadWrite) copied the entire ~13.5 GB
     * of real data from the node-local WORM image to a per-job RW image before
     * mounting (3+ minutes on ext4-backed runners — the dominant cost of the
     * "Workspace cache setup" step). That copy existed only to give the job (a)
     * an isolated writable view and (b) a unique loop-mount so a sibling runner
     * on the same node doesn't conflict — NOT to save back (node-local restores
     * set restoredFromNodeLocal → shouldSkipS3Upload() is true, so nothing is
     * ever uploaded from a consumer).
     *
     * overlayfs gives both for free, instantly:
     *   - lowerdir  = the WORM image mounted READ-ONLY (shared, immutable; a RO
     *     mount needs no UUID randomization — multiple runners can RO-mount the
     *     same image, and xfs `nouuid` covers the duplicate-UUID case);
     *   - upperdir + workdir = on the host temp fs (ext4), which has the real
     *     free space for checkout deltas / build artifacts — replacing the old
     *     filesystem-headroom grow entirely;
     *   - the merged overlay is mounted at the workspace mount point and the
     *     paths are bind-mounted exactly as before.
     *
     * This is the authoritative node-local RW path — there is intentionally NO
     * copy fallback. overlayfs is a kernel builtin on every runner (the cache
     * itself depends on loop + the fs module), so a failure here is a real fault
     * that must surface RED, not be silently papered over by a 3-minute copy.
     */
    protected async overlayMountReadWrite(imageFile: string): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        const lower = path.join(tempDir, "lower"); // RO WORM image mount
        const merged = path.join(tempDir, "mount"); // merged view = workspace

        // CRITICAL #1: overlayfs refuses an upperdir/workdir that is itself on an
        // overlay filesystem (kernel: "filesystem on '...' not supported as
        // upperdir" → mount exit 32). On k8s the per-run temp dir
        // ($RUNNER_TEMP = /home/runner/_work/_temp) IS the pod's overlay rootfs,
        // so upper/work MUST live on a NON-overlay fs. The node-local dir
        // (parent of the WORM image — a hostPath on k8s, the persistent disk on
        // EC2 — real xfs/ext4) is exactly that.
        //
        // CRITICAL #2: the overlay base dir must be UNIQUE PER JOB, not per cache
        // key. The node-local dir persists across jobs on a node (hostPath /
        // reused-runner disk), and overlayfs refuses a workdir that another
        // overlay already used or that is non-empty ("workdir is in-use ..." →
        // exit 32 with "wrong fs type, bad option, bad superblock"). Using a
        // cache-key-derived name (the $RUNNER_TEMP basename is per-key,
        // deterministic) collided run-over-run on the same node. A random
        // per-invocation suffix gives each job its own clean upper/work; both are
        // on the same fs (required) and removed on teardown / stale-swept.
        const nodeLocalDir = path.dirname(imageFile);
        const safeKey = this.cacheKey.replace(/[^a-zA-Z0-9\-_.]/g, "_");
        const overlayBase = path.join(
            nodeLocalDir,
            `.overlay-${safeKey}-${crypto.randomBytes(6).toString("hex")}`
        );
        const upper = path.join(overlayBase, "upper"); // RW deltas
        const work = path.join(overlayBase, "work"); // overlay workdir (same fs)
        this.overlayBaseDir = overlayBase;

        // PERF (teardown): optionally back overlayBase (which holds upper+work)
        // with a DEDICATED per-job ext4 loop image instead of a plain dir on the
        // shared node-local fs. The upper accumulates a copy-up of everything the
        // job writes to the workspace (a full node_modules + checkout is ~700k
        // files); on a plain shared dir, teardown must unlink() every one of them
        // on the runner's critical path (~56s, blocking job.completed_at). On its
        // own filesystem, teardown is O(1): unmount + delete the single backing
        // file drops all inodes with the fs.
        //
        // The image is fallocate-FULL (non-sparse) + no-journal ext4 + direct-io
        // (see Ext4UpperImage). A sparse XFS-on-loop attempt stalled 17 min on a
        // live job (per-block host-fs allocation journaling + block-layer
        // writeback throttle) — full-alloc + no journal + direct-io is what
        // avoids that. NO live growth (avoids losetup -c corruption on a mounted
        // device). Best-effort: any failure (e.g. host disk can't fallocate the
        // full size) falls back to a plain-dir upper — correctness over the
        // optimization.
        const overlayUpperSize = this.options.overlayUpperSize;
        const upperImageFile = `${overlayBase}.img`;
        let upperImage: Ext4UpperImage | undefined;

        try {
            await fs.mkdir(overlayBase, { recursive: true });

            if (overlayUpperSize) {
                const img = new Ext4UpperImage(upperImageFile, this.safeCwd);
                try {
                    await img.create(overlayUpperSize);
                    await img.mountRW(overlayBase);
                    upperImage = img;
                    this.overlayUpperImage = img;
                    this.overlayUpperImageFile = upperImageFile;
                } catch (e) {
                    this.logInfo(
                        `Overlay upper ext4 loop-image setup failed (${
                            e instanceof Error ? e.message : e
                        }); using plain-dir upper (slower teardown)`
                    );
                    try {
                        await img.unmount(overlayBase);
                    } catch {
                        /* not mounted */
                    }
                    try {
                        await fs.rm(upperImageFile, { force: true });
                    } catch {
                        /* ignore */
                    }
                    this.overlayUpperImage = undefined;
                    this.overlayUpperImageFile = undefined;
                }
            }

            await fs.mkdir(lower, { recursive: true });
            await fs.mkdir(upper, { recursive: true });
            await fs.mkdir(work, { recursive: true });
            await fs.mkdir(merged, { recursive: true });

            // 1. Mount the WORM image READ-ONLY as the overlay lower layer. No
            //    copy, no UUID randomize — RO + fs-specific ro options (xfs:
            //    norecovery,nouuid) make concurrent RO mounts of the shared
            //    image safe.
            this.image.setImageFile(imageFile);
            await this.image.mountRO(lower);

            // 2. Mount the overlay: RO lower + RW upper, merged at the workspace
            //    mount point. Writes land in `upper` on the host fs (which has
            //    the free space), the WORM image stays pristine.
            //
            // `volatile`: the upper is ALWAYS throwaway here — every
            // overlayMountReadWrite caller is a consumer (restoredFromNodeLocal),
            // never saved/uploaded; producers use skip-restore, not this path.
            // Without it, umount at job end force-syncs multi-GB of dirty upper
            // pages to the instance disk (throttled by rq_qos_wait), adding up to
            // ~2.5 min to teardown. volatile skips the sync barrier (pages
            // discarded, not flushed) — upper stays on-disk, so no RAM cost.
            // Verified on kernel 6.12.88: volatile umount = 0s vs ~2.5 min.
            this.logInfo(
                `Overlay RW mount (no copy, volatile): lower=${imageFile} (ro) upper=${upper}`
            );
            // Capture stdout/stderr/exit so a mount failure surfaces the REAL
            // kernel reason (e.g. "wrong fs type", "failed to verify upper root
            // origin", d_type/index issues) instead of an opaque exit 32.
            const ov = await exec.getExecOutput(
                "sudo",
                [
                    "mount",
                    "-t",
                    "overlay",
                    "overlay",
                    "-o",
                    `lowerdir=${lower},upperdir=${upper},workdir=${work},volatile`,
                    merged
                ],
                { cwd: this.safeCwd, ignoreReturnCode: true }
            );
            if (ov.exitCode !== 0) {
                // Pull the matching kernel message for the real cause.
                const dmesg = await exec
                    .getExecOutput(
                        "bash",
                        [
                            "-c",
                            "sudo dmesg 2>/dev/null | grep -i overlay | tail -5 || true"
                        ],
                        { cwd: this.safeCwd, ignoreReturnCode: true, silent: true }
                    )
                    .catch(() => ({ stdout: "" }));
                throw new Error(
                    `mount -t overlay exit ${ov.exitCode}: ${
                        ov.stderr.trim() || ov.stdout.trim() || "(no output)"
                    }${dmesg.stdout ? ` | dmesg: ${dmesg.stdout.trim()}` : ""}`
                );
            }

            this.mountPoint = merged;
            this.usingOverlay = true;
            this.overlayLowerMount = lower;
            // No rawImageFile to persist (consumer never saves), and no
            // expand-for-headroom: the upperdir already has the host's free
            // space. Bind the cached paths onto the workspace from the merged
            // overlay.
            await this.bindMountPaths(false);
        } catch (error) {
            // No copy fallback — a failed overlay is a real fault that must go
            // RED. Best-effort teardown of any partial overlay/lower mount so we
            // don't leak a mount, then rethrow.
            try {
                await this.image.unmount(lower);
            } catch {
                /* ignore */
            }
            // If the upper is image-backed, unmount the ext4 image (detach its
            // loop) + delete the backing file BEFORE removing the base dir —
            // otherwise fs.rm hits a live mount / leaks a loop device.
            if (upperImage) {
                try {
                    await upperImage.unmount(overlayBase);
                } catch {
                    /* ignore */
                }
                try {
                    await fs.rm(upperImageFile, { force: true });
                } catch {
                    /* ignore */
                }
            }
            try {
                await fs.rm(overlayBase, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
            this.usingOverlay = false;
            this.overlayLowerMount = undefined;
            this.overlayBaseDir = undefined;
            this.overlayUpperImage = undefined;
            this.overlayUpperImageFile = undefined;
            throw new Error(
                `Overlay RW mount failed for node-local image ${imageFile}: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    protected async copyAndMountReadWrite(imageFile: string): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        const localCopy = path.join(tempDir, this.localCopyName());

        this.logInfo(`Copying for RW mount: ${imageFile} → ${localCopy}`);
        await this.copyImage(imageFile, localCopy);

        // Verify copy integrity: file size must match original
        const [srcStat, dstStat] = await Promise.all([
            fs.stat(imageFile),
            fs.stat(localCopy)
        ]);
        if (srcStat.size !== dstStat.size) {
            throw new Error(
                `Copy integrity check failed: source ${srcStat.size} bytes vs copy ${dstStat.size} bytes`
            );
        }
        this.logInfo(
            `Copy verified: ${Math.round(dstStat.size / (1024 * 1024))} MB`
        );

        // Randomize UUID so kernel doesn't reject duplicate of node-local original
        this.image.setImageFile(localCopy);
        await this.image.randomizeUuid();

        // This copy is now the image we mount and (on save) persist.
        this.rawImageFile = localCopy;
        this.onRawImageCopied(localCopy);
        await this.mountImageReadWrite({ expandForHeadroom: true });
    }

    // ── Bind mounts ──────────────────────────────────────────────────

    protected async bindMountPaths(readOnly: boolean): Promise<void> {
        const promises = this.pathsToCache.map(async p => {
            if (!this.mountPoint) {
                throw new Error("Mount point is not set");
            }

            // For absolute paths, use directly as workspace target.
            // path.join(mountPoint, p) strips leading '/' and nests inside mount.
            const absPath = path.isAbsolute(p) ? p : path.join(this.baseDir, p);
            const imagePath = path.join(this.mountPoint, p);

            core.debug(
                `${this.getLogPrefix()} Bind-mounting ${imagePath} → ${absPath}${
                    readOnly ? " (ro)" : ""
                }`
            );

            try {
                if (readOnly) {
                    // RO: source must exist in image; only create workspace target
                    try {
                        await exec.exec("test", ["-d", imagePath], {
                            cwd: this.safeCwd,
                            ignoreReturnCode: false,
                            silent: !core.isDebug()
                        });
                    } catch {
                        throw new Error(
                            `Source path ${imagePath} does not exist in ${this.fsDisplayName} image`
                        );
                    }
                    await this.execSudo("mkdir", ["-p", absPath]);
                    await this.execSudo("chown", [
                        "--reference",
                        path.dirname(absPath),
                        absPath
                    ]);
                } else {
                    // RW: create directories on both sides
                    await Promise.all([
                        this.execSudo("mkdir", ["-p", imagePath]),
                        this.execSudo("mkdir", ["-p", absPath])
                    ]);
                    await Promise.all([
                        this.execSudo("chown", [
                            "--reference",
                            path.dirname(absPath),
                            absPath
                        ]),
                        this.execSudo("chown", [
                            "--reference",
                            this.baseDir,
                            imagePath
                        ])
                    ]);
                }

                // Bind mount
                await exec.exec(
                    "sudo",
                    ["mount", "-o", "bind", imagePath, absPath],
                    { cwd: this.safeCwd, silent: !core.isDebug() }
                );

                // Remount read-only if requested
                if (readOnly) {
                    await exec.exec(
                        "sudo",
                        ["mount", "-o", "bind,remount,ro", imagePath, absPath],
                        { cwd: this.safeCwd, silent: !core.isDebug() }
                    );
                }
            } catch (error) {
                throw new Error(
                    `Failed to bind-mount ${imagePath} to ${absPath}: ${
                        error instanceof Error ? error.message : error
                    }`
                );
            }
        });
        await Promise.all(promises);
    }

    // ── Unmount ──────────────────────────────────────────────────────

    protected async unmountAll(): Promise<void> {
        if (!this.mountPoint) {
            throw new Error("Mount point is not set");
        }

        // Unmount bind mounts first
        for (const p of this.pathsToCache) {
            const absPath = path.isAbsolute(p) ? p : path.join(this.baseDir, p);
            try {
                const rc = await exec.exec("mountpoint", [absPath], {
                    cwd: this.safeCwd,
                    ignoreReturnCode: true,
                    silent: !core.isDebug()
                });
                if (rc === 0) {
                    core.debug(
                        `${this.getLogPrefix()} Unmounting bind mount: ${absPath}`
                    );
                    await this.image.umountSafe(absPath);
                }
            } catch (error) {
                core.debug(`Failed to unmount bind mount ${absPath}: ${error}`);
            }
        }

        // Then unmount main filesystem + detach loop
        await this.image.unmount(this.mountPoint);
    }

    protected async cleanStaleMounts(): Promise<void> {
        for (const p of this.pathsToCache) {
            const absPath = path.isAbsolute(p) ? p : path.join(this.baseDir, p);
            await this.unmountIfMounted(absPath);
        }
        if (this.mountPoint) {
            await this.unmountIfMounted(this.mountPoint);
        }
    }

    private async unmountIfMounted(targetPath: string): Promise<void> {
        try {
            const rc = await exec.exec("mountpoint", ["-q", targetPath], {
                cwd: this.safeCwd,
                ignoreReturnCode: true,
                silent: true
            });
            if (rc === 0) {
                core.warning(
                    `${this.getLogPrefix()} Stale mount detected at ${targetPath}, unmounting...`
                );
                await this.image.umountSafe(targetPath);
            }
        } catch {
            // targetPath doesn't exist or mountpoint check failed
        }
    }

    // ── Discovery ────────────────────────────────────────────────────

    /**
     * Detect an active consumer overlay mounted at `expectedMountPoint` and
     * re-derive the teardown targets from its live mount options. Runs in the
     * SAVE process (a fresh instance where usingOverlay/overlayBaseDir/etc. are
     * unset), so everything is recovered from `findmnt -t overlay`:
     *   upperdir=<overlayBase>/upper  → overlayBaseDir = dirname(upperdir)
     *   lowerdir=<tempDir>/lower       → overlayLowerMount
     * The upper filesystem image (if used) is <overlayBase>.img; if it exists,
     * re-derive its loop device from findmnt so dropOverlayFast can detach it.
     * Returns true if an overlay was found (caller should stop normal discovery).
     */
    protected async detectOverlayMount(
        expectedMountPoint: string
    ): Promise<boolean> {
        try {
            const out = await exec.getExecOutput(
                "findmnt",
                [
                    "-t",
                    "overlay",
                    "-n",
                    "-o",
                    "TARGET,OPTIONS",
                    expectedMountPoint
                ],
                {
                    cwd: this.safeCwd,
                    silent: !core.isDebug(),
                    ignoreReturnCode: true
                }
            );
            const line = out.stdout.trim();
            if (out.exitCode !== 0 || !line) return false;

            const options = line.split(/\s+/).slice(1).join(" ");
            const upperM = options.match(/upperdir=([^,\s]+)/);
            const lowerM = options.match(/lowerdir=([^,\s]+)/);
            if (!upperM) return false;

            this.mountPoint = expectedMountPoint;
            this.usingOverlay = true;
            this.overlayBaseDir = path.dirname(upperM[1]); // .../upper → base
            if (lowerM) this.overlayLowerMount = lowerM[1];

            // Only treat the upper as image-backed if the .img file exists.
            const candidateImg = `${this.overlayBaseDir}.img`;
            try {
                await fs.access(candidateImg);
                this.overlayUpperImageFile = candidateImg;
                // Re-derive the loop device backing the upper image mount so we
                // can detach it at teardown (this fresh process did not attach
                // it). findmnt the base dir → SOURCE is the /dev/loopN device.
                const upperMnt = await exec.getExecOutput(
                    "findmnt",
                    ["-n", "-o", "SOURCE", this.overlayBaseDir as string],
                    {
                        cwd: this.safeCwd,
                        silent: !core.isDebug(),
                        ignoreReturnCode: true
                    }
                );
                const dev = upperMnt.stdout.trim().split(/\s+/)[0];
                const img = new Ext4UpperImage(candidateImg, this.safeCwd);
                if (dev && dev.startsWith("/dev/loop")) {
                    img.setLoopDevice(dev);
                }
                this.overlayUpperImage = img;
            } catch {
                this.overlayUpperImageFile = undefined;
                this.overlayUpperImage = undefined;
            }
            this.logInfo(
                `Detected consumer overlay at ${expectedMountPoint} (base=${this.overlayBaseDir}` +
                    `${
                        this.overlayUpperImageFile
                            ? ", ext4 image-backed upper"
                            : ""
                    })`
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Tear down a consumer overlay in O(1) (not O(files)). Order:
     *   1. plain `umount` the merged overlay (NO loop-detach — the merged mount
     *      has no loop device; the upper image's loop is detached in step 2).
     *   2. if the upper is on a dedicated ext4 loop image: unmount it (detaches
     *      its loop) then delete the ONE backing .img file — frees all upper
     *      inodes with the filesystem, no per-file unlink. Then rmdir the (now
     *      empty) base.
     *      else (plain-dir upper fallback): recursively rm the base — the slow
     *      O(files) path, only when no image backed the upper.
     *   3. unmount the RO lower image mount + detach its loop.
     * All best-effort: on failure the pod teardown still reaps it (slow but
     * correct).
     */
    protected async dropOverlayFast(): Promise<void> {
        const base = this.overlayBaseDir;

        // 1. Unmount the merged overlay (plain umount, lazy fallback for busy).
        if (this.mountPoint) {
            try {
                await this.execSudo("umount", [this.mountPoint]);
            } catch {
                try {
                    await this.execSudo("umount", ["-l", this.mountPoint]);
                } catch {
                    /* ignore — pod teardown reaps it */
                }
            }
        }

        // 2. Drop the upper.
        if (base) {
            if (this.overlayUpperImage && this.overlayUpperImageFile) {
                // Image-backed upper → unmount the ext4 image (detaches loop) +
                // rm the single backing file. O(1) regardless of file count.
                try {
                    await this.overlayUpperImage.unmount(base);
                } catch {
                    try {
                        await this.execSudo("umount", ["-l", base]);
                    } catch {
                        /* ignore */
                    }
                }
                try {
                    await fs.rm(this.overlayUpperImageFile, { force: true });
                } catch {
                    /* ignore */
                }
                try {
                    // base is now an empty dir (its contents lived in the image).
                    await fs.rm(base, { recursive: false, force: true });
                } catch {
                    /* dir may be non-empty if unmount failed; leave for sweeper */
                }
                this.logInfo(
                    "Dropped overlay upper ext4 image (O(1) teardown)"
                );
            } else {
                // Plain-dir upper fallback → recursive rm (the slow O(files)
                // path; only hit when no image backed the upper).
                try {
                    await fs.rm(base, { recursive: true, force: true });
                    this.logInfo(
                        "Removed plain-dir overlay upper (O(files) teardown)"
                    );
                } catch (e) {
                    this.logInfo(
                        `Overlay upper removal failed (${
                            e instanceof Error ? e.message : e
                        }); pod teardown will reap it`
                    );
                }
            }
        }

        // 3. Unmount the RO lower image (detach its loop).
        if (this.overlayLowerMount) {
            try {
                await this.image.unmount(this.overlayLowerMount);
            } catch {
                try {
                    await this.execSudo("umount", [
                        "-l",
                        this.overlayLowerMount
                    ]);
                } catch {
                    /* ignore */
                }
            }
        }

        this.usingOverlay = false;
        this.overlayBaseDir = undefined;
        this.overlayLowerMount = undefined;
        this.overlayUpperImage = undefined;
        this.overlayUpperImageFile = undefined;
    }

    protected async discoverMountInfo(): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        const expectedMountPoint = path.join(tempDir, "mount");

        this.logDebug(
            `Looking for ${this.fsDisplayName} mount at: ${expectedMountPoint}`
        );

        // OVERLAY consumer path FIRST: the save process is a fresh instance, so
        // usingOverlay/overlayBaseDir/etc. are unset and the `-t <xfs|btrfs>`
        // search below can't see an overlay-type mount (it lives at
        // expectedMountPoint but is fs-type "overlay", and the RO lower is at
        // .../lower). Detect the overlay here and re-derive the teardown targets
        // from its mount options so dropOverlayFast() can run in the save step.
        if (await this.detectOverlayMount(expectedMountPoint)) {
            return;
        }

        let output = "";
        await exec.exec(
            "findmnt",
            ["-t", this.findmntFsType(), "-n", "-o", "TARGET,SOURCE,OPTIONS"],
            {
                cwd: this.safeCwd,
                listeners: {
                    stdout: (data: Buffer) => {
                        output += data.toString();
                    }
                },
                silent: !core.isDebug()
            }
        );
        output = output.trim();
        this.logDebug(`findmnt output:\n${output}`);

        const lines = output.split("\n");
        for (const line of lines) {
            if (line.trim() === "") continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const mountPoint = parts[0];
                const options = parts.slice(2).join(" ");

                if (mountPoint === expectedMountPoint) {
                    const source = parts[1];
                    this.logDebug(
                        `Found existing mount: ${source} → ${mountPoint} (${options})`
                    );
                    this.mountPoint = mountPoint;
                    this.mountIsReadOnly = /\bro\b/.test(options);
                    await this.onMountDiscovered(source);
                    this.logDebug(
                        `Using image: ${this.rawImageFile} (readOnly=${this.mountIsReadOnly})`
                    );
                    return;
                }
            }
        }

        throw new Error(
            `No ${this.fsDisplayName} cache filesystem found for cache key ${this.cacheKey}. ` +
                `Expected mount at: ${expectedMountPoint}.`
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /**
     * Find an existing mount for the given image file.
     * Another runner on the same node may have already attached a loop device
     * and mounted it. Returns the mount point path, or null if not mounted.
     */
    protected async findExistingMount(
        imageFile: string
    ): Promise<string | null> {
        try {
            // 1. Find loop device(s) attached to this file
            const losetupOut = await exec.getExecOutput(
                "losetup",
                ["-j", imageFile],
                { cwd: this.safeCwd, silent: true, ignoreReturnCode: true }
            );
            if (losetupOut.exitCode !== 0 || !losetupOut.stdout.trim())
                return null;

            // Parse: "/dev/loop5: 7:0 (/opt/.../file.ext)"
            const match = losetupOut.stdout.match(/^(\/dev\/loop\d+):/m);
            if (!match) return null;

            const loopDev = match[1];

            // 2. Find mount point for this loop device
            const findmntOut = await exec.getExecOutput(
                "findmnt",
                ["-n", "-o", "TARGET", loopDev],
                { cwd: this.safeCwd, silent: true, ignoreReturnCode: true }
            );
            const mountTarget = findmntOut.stdout.trim();
            if (findmntOut.exitCode !== 0 || !mountTarget) return null;

            // Return only the first mount point (there could be bind mounts)
            return mountTarget.split("\n")[0].trim();
        } catch {
            return null;
        }
    }

    /**
     * Check if the container file is inside the node-local WORM cache dir.
     * When true, we must copy + UUID-randomize before RW mount to avoid
     * UUID collisions with other runners sharing the same WORM source.
     */
    protected isInNodeLocalDir(): boolean {
        if (!this.nodeLocal.enabled) return false;
        const cacheDir = path.dirname(this.nodeLocal.localPath);
        return this.containerFile.startsWith(cacheDir + "/");
    }

    /**
     * Copy a raw loop image. Default uses fs.copyFile (btrfs: the image was
     * already compressed/right-sized via resize+truncate, so a plain copy is
     * fine). xfs overrides this with a sparse-preserving copy because the raw
     * xfs image is a sparse 25G file and fs.copyFile would balloon it to 25G
     * physical on disk (see XfsContainer.copyImage).
     */
    protected async copyImage(src: string, dst: string): Promise<void> {
        await fs.copyFile(src, dst);
    }

    protected async execSudo(
        command: string,
        args: string[] = []
    ): Promise<void> {
        await exec.exec("sudo", [command, ...args], {
            cwd: this.safeCwd,
            silent: !core.isDebug()
        });
    }

    protected checkPathTraversal(base: string, pathToCheck: string): void {
        const absBase = path.resolve(base);
        const absPathToCheck = path.resolve(path.join(base, pathToCheck));
        if (!absPathToCheck.startsWith(absBase)) {
            throw new Error(
                `Path traversal detected: ${pathToCheck} resolves outside base directory`
            );
        }
    }
}
