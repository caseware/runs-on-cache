/**
 * BtrfsContainer — thin orchestrator for BTRFS-backed cache entries.
 *
 * Delegates image lifecycle (create/mount/unmount/resize/verify) to BtrfsImage.
 * Owns bind-mount logic (workspace ↔ BTRFS image paths) and node-local caching.
 *
 * Split rationale (A): BtrfsImage is a pure filesystem primitive; BtrfsContainer
 * adds the cache-action-specific orchestration (bind mounts, node-local, key tracking).
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Inputs } from "../../constants";
import { createCacheKeySpecificTempDirectory } from "../actionUtils";
import { Container, ContainerOptions } from "./Container";
import { BtrfsImage, validateFsSize, validateCompressionLevel } from "./BtrfsImage";

export class BtrfsContainer extends Container {
    public requiresCreateEmptyCache = true;
    public requiresKeepArchive = true;

    private mountPoint: string | undefined;
    private readonly fsSize: string;
    private readonly mountMode: "ro" | "rw";
    private readonly image: BtrfsImage;

    /** Set to true if save verification fails. */
    private saveAborted = false;
    /** True if the current BTRFS mount is read-only. */
    private mountIsReadOnly = false;
    /** Per-run temp dir used as CWD for all exec calls. */
    private safeCwd = "";

    constructor(
        containerFile: string,
        compressionMethod: string,
        compressionLevel: string | undefined,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerOptions
    ) {
        if (!compressionLevel) {
            compressionLevel = "zstd:3";
        }

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
            throw new Error("fsSize option is required for BtrfsContainer");
        }

        this.fsSize = options.fsSize;
        this.mountMode = options.mountMode || "rw";

        // Input validation
        validateFsSize(this.fsSize);
        if (this.compressionLevel) {
            validateCompressionLevel(this.compressionLevel);
        }
        const saveCompLevel = options.saveCompressionLevel || "zstd:3";
        validateCompressionLevel(saveCompLevel);

        this.checkPathTraversal(this.baseDir, this.containerFile);
        this.pathsToCache.forEach(p =>
            this.checkPathTraversal(this.baseDir, p)
        );

        // BtrfsImage handles all image-level operations (A)
        // Save buffer: zero — the 50G sparse virtual size gives defrag/recompress
        // all the room it needs. After defrag+sync, resize to exact Device allocated.
        // RW restore headroom: dynamic 80% utilization target (expand after mount).
        this.image = new BtrfsImage(containerFile, {
            compressionLevel: this.compressionLevel!,
            saveCompressionLevel: saveCompLevel,
            saveBufferBytes: 0,
            rwUtilizationTarget: 0.80,
            safeCwd: "" // set in initialize()
        });
    }

    protected nodeLocalExtension(): string {
        return ".btrfs";
    }

    isSupportedMethod(method?: string): boolean {
        return (method?.split("-")[0] || method) === "btrfs";
    }

    async initialize(): Promise<void> {
        this.safeCwd = await fs.mkdtemp(path.join(os.tmpdir(), "btrfs-"));
        this.image.setSafeCwd(this.safeCwd);

        try {
            await this.image.checkPrerequisites();
        } catch (e) {
            core.setFailed((e as Error).message);
            process.exit(1);
        }

        try {
            await this.nodeLocal.cleanupStaleTempFiles();
            await this.nodeLocal.cleanupStaleActiveFiles();
        } catch (e) {
            core.warning(
                `${this.getLogPrefix()} Stale cleanup failed (non-fatal): ${
                    (e as Error).message
                }`
            );
        }

        // LRU eviction: remove oldest WORM images if disk budget exceeded
        try {
            const maxGb = parseFloat(
                core.getInput(Inputs.MaxNodeLocalGb) || "30"
            );
            if (maxGb > 0) {
                await this.nodeLocal.evictLRU(maxGb);
            }
        } catch (e) {
            core.warning(
                `${this.getLogPrefix()} LRU eviction failed (non-fatal): ${
                    (e as Error).message
                }`
            );
        }
    }

    protected getLogPrefix(): string {
        return "[BTRFS]";
    }

    /**
     * Override setArchivePath to keep BtrfsImage.imageFile in sync with
     * Container.containerFile. Without this, node-local S3 download path
     * updates containerFile but the image still points to the original
     * $RUNNER_TEMP path (which doesn't exist when download went to node-local).
     */
    setArchivePath(archivePath: string): void {
        super.setArchivePath(archivePath);
        this.image.setImageFile(archivePath);
    }

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
                    // Try pool copy first (pre-randomized UUID, atomic rename)
                    const poolCopy = await this.tryAcquirePoolAndMount();
                    if (poolCopy) {
                        this.restoredFromNodeLocal = true;
                        return true;
                    }
                    // Fallback: copy from WORM + UUID randomize
                    await this.copyAndMountReadWrite(localPath);
                } else {
                    await this.mountImageReadOnly(localPath);
                }
                this.restoredFromNodeLocal = true;
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
            const closestMatch =
                await this.nodeLocal.findClosestMatch(restoreKeys);
            if (closestMatch) {
                try {
                    this.logInfo(
                        `Node-local partial hit — copying ${path.basename(closestMatch)} for RW augmentation`
                    );
                    // Pool copies are keyed to exact match; partial hits always copy
                    await this.copyAndMountReadWrite(closestMatch);
                    this.restoredFromNodeLocal = true;
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
            if (this.mountMode === "ro") {
                await this.mountImageReadOnly(this.containerFile);
            } else {
                // When the container file lives in the node-local WORM dir
                // (S3 download → node-local commit), we must copy + randomize
                // UUID before RW mount. Without this, two runners on the same
                // node get exit code 32 (EEXIST) from BTRFS UUID collision.
                if (this.isInNodeLocalDir()) {
                    // Try pool copy first (pre-randomized, atomic rename)
                    const poolMounted = await this.tryAcquirePoolAndMount();
                    if (!poolMounted) {
                        this.logInfo(
                            "No pool copy available — copying from WORM for RW mount"
                        );
                        await this.copyAndMountReadWrite(this.containerFile);
                    }
                } else {
                    await this.mountImageReadWrite();
                    await this.image.expandForHeadroom(this.mountPoint!);
                }
                await this.image.checkHealth(this.mountPoint!);
            }
        } catch (error) {
            await this.image.cleanupLoopDevices(this.containerFile);
            throw this.wrapError("restore BTRFS cache", error);
        }
    }

    async createEmptyCache(): Promise<void> {
        try {
            await this.image.createSparseImage(this.fsSize);
            return this.mountImageReadWrite();
        } catch (error) {
            await this.image.cleanupLoopDevices(this.containerFile);
            // Clean up the sparse file so the save step doesn't upload
            // an empty 12GB BTRFS image to S3.
            try {
                await fs.unlink(this.containerFile);
                this.logInfo("Cleaned up sparse file after mount failure");
            } catch { /* file may not exist */ }
            throw this.wrapError("create empty BTRFS cache", error);
        }
    }

    async save(): Promise<void> {
        try {
            await this.discoverMountInfo();
        } catch {
            this.logInfo("No BTRFS mount found — skipping save");
            // Delete any stale container file (e.g. empty sparse image from
            // failed createEmptyCache) to prevent the S3 upload from picking
            // it up. Without this, a 12GB empty image gets uploaded.
            try {
                await fs.unlink(this.containerFile);
            } catch { /* file may not exist */ }
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

        // Defrag + resize + truncate
        await this.image.prepareSave(this.mountPoint);

        // Unmount all bind mounts + main mount
        await this.unmountAll();

        // Verify image is mountable before upload
        const ok = await this.image.verifyMountable();
        if (!ok) {
            this.saveAborted = true;
            throw new Error(
                "BTRFS verification mount failed — aborting save to prevent cache poisoning"
            );
        }

        this.logDebug(
            `Save completed. Container file ready for upload: ${this.containerFile}`
        );
    }

    shouldSkipS3Upload(): boolean {
        return this.mountIsReadOnly || this.saveAborted;
    }

    // ── Private: mount orchestration ─────────────────────────────────

    private async mountImageReadOnly(imageFile: string): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        this.mountPoint = path.join(tempDir, "mount");

        // Sync image path — imageFile may differ from the original containerFile
        // (e.g. node-local path vs $RUNNER_TEMP path after S3 download to node-local)
        this.image.setImageFile(imageFile);

        await this.cleanStaleMounts();

        // For shared node-local WORM files, another runner on the same node
        // may already have a loop device + mount. Creating a second loop device
        // triggers BTRFS UUID collision (exit 32). Reuse the existing mount
        // via bind mount instead.
        const existingMount = await this.findExistingBtrfsMount(imageFile);
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

    private async mountImageReadWrite(): Promise<void> {
        try {
            const tempDir = await createCacheKeySpecificTempDirectory(
                this.cacheKey
            );
            this.mountPoint = path.join(tempDir, "mount");

            await this.cleanStaleMounts();
            await this.image.mountRW(this.mountPoint);
            await this.bindMountPaths(false);
        } catch (error) {
            await this.image.cleanupLoopDevices(this.containerFile);
            throw new Error(
                `Failed to mount BTRFS filesystem: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    /**
     * Try to acquire a pool copy and mount it directly (no copy, no UUID randomization).
     * Pool copies are pre-randomized by the cache-warmer DaemonSet.
     */
    private async tryAcquirePoolAndMount(): Promise<boolean> {
        const activePath = await this.nodeLocal.tryAcquirePoolCopy();
        if (!activePath) return false;

        try {
            this.logInfo(
                `Mounting prestaged pool copy: ${path.basename(activePath)}`
            );
            this.image.setImageFile(activePath);
            this.containerFile = activePath;
            core.saveState("BTRFS_CONTAINER_FILE", activePath);
            await this.mountImageReadWrite();
            await this.image.expandForHeadroom(this.mountPoint!);
            return true;
        } catch (error) {
            core.warning(
                `${this.getLogPrefix()} Pool copy mount failed, will fall back to copy: ${
                    error instanceof Error ? error.message : error
                }`
            );
            // Clean up the failed active file
            try { await fs.unlink(activePath); } catch { /* ignore */ }
            return false;
        }
    }

    private async copyAndMountReadWrite(imageFile: string): Promise<void> {
        // Place the copy in the same directory as the WORM image when possible
        // so that cleanup is centralized and the file is on the same filesystem.
        const activePath = this.nodeLocal.enabled
            ? this.nodeLocal.createActivePath()
            : path.join(
                  await createCacheKeySpecificTempDirectory(this.cacheKey),
                  "cache.btrfs"
              );

        this.logInfo(`Copying for RW mount: ${imageFile} → ${activePath}`);
        await fs.copyFile(imageFile, activePath);

        // Verify copy integrity: file size must match original
        const [srcStat, dstStat] = await Promise.all([
            fs.stat(imageFile),
            fs.stat(activePath)
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
        this.image.setImageFile(activePath);
        await this.image.randomizeUuid();

        this.containerFile = activePath;
        core.saveState("BTRFS_CONTAINER_FILE", activePath);
        await this.mountImageReadWrite();
        await this.image.expandForHeadroom(this.mountPoint!);
    }

    // ── Bind mounts ──────────────────────────────────────────────────

    private async bindMountPaths(readOnly: boolean): Promise<void> {
        const promises = this.pathsToCache.map(async p => {
            if (!this.mountPoint) {
                throw new Error("Mount point is not set");
            }

            // For absolute paths, use directly as workspace target.
            // path.join(mountPoint, p) strips leading '/' and nests inside mount.
            const absPath = path.isAbsolute(p)
                ? p
                : path.join(this.baseDir, p);
            const btrfsPath = path.join(this.mountPoint, p);

            core.debug(
                `[BTRFS] Bind-mounting ${btrfsPath} → ${absPath}${readOnly ? " (ro)" : ""}`
            );

            try {
                if (readOnly) {
                    // RO: source must exist in image; only create workspace target
                    try {
                        await exec.exec("test", ["-d", btrfsPath], {
                            cwd: this.safeCwd,
                            ignoreReturnCode: false,
                            silent: !core.isDebug()
                        });
                    } catch {
                        throw new Error(
                            `Source path ${btrfsPath} does not exist in BTRFS image`
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
                        this.execSudo("mkdir", ["-p", btrfsPath]),
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
                            btrfsPath
                        ])
                    ]);
                }

                // Bind mount
                await exec.exec(
                    "sudo",
                    ["mount", "-o", "bind", btrfsPath, absPath],
                    { cwd: this.safeCwd, silent: !core.isDebug() }
                );

                // Remount read-only if requested
                if (readOnly) {
                    await exec.exec(
                        "sudo",
                        [
                            "mount",
                            "-o",
                            "bind,remount,ro",
                            btrfsPath,
                            absPath
                        ],
                        { cwd: this.safeCwd, silent: !core.isDebug() }
                    );
                }
            } catch (error) {
                throw new Error(
                    `Failed to bind-mount ${btrfsPath} to ${absPath}: ${
                        error instanceof Error ? error.message : error
                    }`
                );
            }
        });
        await Promise.all(promises);
    }

    // ── Unmount ──────────────────────────────────────────────────────

    private async unmountAll(): Promise<void> {
        if (!this.mountPoint) {
            throw new Error("Mount point is not set");
        }

        // Unmount bind mounts first
        for (const p of this.pathsToCache) {
            const absPath = path.isAbsolute(p)
                ? p
                : path.join(this.baseDir, p);
            try {
                const rc = await exec.exec("mountpoint", [absPath], {
                    cwd: this.safeCwd,
                    ignoreReturnCode: true,
                    silent: !core.isDebug()
                });
                if (rc === 0) {
                    core.debug(`[BTRFS] Unmounting bind mount: ${absPath}`);
                    await this.image.umountSafe(absPath);
                }
            } catch (error) {
                core.debug(
                    `Failed to unmount bind mount ${absPath}: ${error}`
                );
            }
        }

        // Then unmount main filesystem + detach loop
        await this.image.unmount(this.mountPoint);
    }

    private async cleanStaleMounts(): Promise<void> {
        for (const p of this.pathsToCache) {
            const absPath = path.isAbsolute(p)
                ? p
                : path.join(this.baseDir, p);
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

    private async discoverMountInfo(): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        const expectedMountPoint = path.join(tempDir, "mount");

        this.logDebug(`Looking for BTRFS mount at: ${expectedMountPoint}`);

        let output = "";
        await exec.exec("findmnt", ["-t", "btrfs", "-n", "-o", "TARGET,SOURCE,OPTIONS"], {
            cwd: this.safeCwd,
            listeners: {
                stdout: (data: Buffer) => {
                    output += data.toString();
                }
            },
            silent: !core.isDebug()
        });
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
                    this.logDebug(
                        `Found existing mount: ${parts[1]} → ${mountPoint} (${options})`
                    );
                    this.mountPoint = mountPoint;
                    this.mountIsReadOnly = /\bro\b/.test(options);
                    this.logDebug(
                        `Using containerFile: ${this.containerFile} (readOnly=${this.mountIsReadOnly})`
                    );
                    return;
                }
            }
        }

        throw new Error(
            `No BTRFS cache filesystem found for cache key ${this.cacheKey}. ` +
                `Expected mount at: ${expectedMountPoint}.`
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /**
     * Find an existing BTRFS mount for the given image file.
     * Another runner on the same node may have already attached a loop device
     * and mounted it. Returns the mount point path, or null if not mounted.
     */
    private async findExistingBtrfsMount(
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

            // Parse: "/dev/loop5: 7:0 (/opt/.../file.btrfs)"
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
    private isInNodeLocalDir(): boolean {
        if (!this.nodeLocal.enabled) return false;
        const cacheDir = path.dirname(this.nodeLocal.localPath);
        return this.containerFile.startsWith(cacheDir + "/");
    }

    private async execSudo(
        command: string,
        args: string[] = []
    ): Promise<void> {
        await exec.exec("sudo", [command, ...args], {
            cwd: this.safeCwd,
            silent: !core.isDebug()
        });
    }

    private checkPathTraversal(base: string, pathToCheck: string): void {
        const absBase = path.resolve(base);
        const absPathToCheck = path.resolve(path.join(base, pathToCheck));
        if (!absPathToCheck.startsWith(absBase)) {
            throw new Error(
                `Path traversal detected: ${pathToCheck} resolves outside base directory`
            );
        }
    }
}
