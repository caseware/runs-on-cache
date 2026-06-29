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
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createCacheKeySpecificTempDirectory } from "../actionUtils";
import { Container, ContainerOptions } from "./Container";
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
    /** True if the current mount is read-only. */
    protected mountIsReadOnly = false;
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
                    await this.copyAndMountReadWrite(localPath);
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
                        `Node-local partial hit — copying ${path.basename(
                            closestMatch
                        )} for RW augmentation`
                    );
                    await this.copyAndMountReadWrite(closestMatch);
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
                this.logInfo(
                    `Container file is in node-local WORM dir — copying for RW mount`
                );
                await this.copyAndMountReadWrite(this.rawImageFile);
                await this.image.checkHealth(this.mountPoint!);
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
     * (BtrfsCleanup scopedCleanup, fs-agnostic) unmounts it at job end. Any
     * failure here is logged and swallowed — the artifact is already uploaded.
     */
    protected async remountReadOnlyForPostSteps(): Promise<void> {
        try {
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
        } catch (error) {
            core.warning(
                `${this.getLogPrefix()} Read-only remount for post-steps failed (non-fatal, image already saved): ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    shouldSkipS3Upload(): boolean {
        return this.mountIsReadOnly || this.saveAborted;
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

    protected async discoverMountInfo(): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        const expectedMountPoint = path.join(tempDir, "mount");

        this.logDebug(
            `Looking for ${this.fsDisplayName} mount at: ${expectedMountPoint}`
        );

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
