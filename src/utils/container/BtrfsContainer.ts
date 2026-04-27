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
        this.image = new BtrfsImage(containerFile, {
            compressionLevel: this.compressionLevel!,
            saveCompressionLevel: saveCompLevel,
            bufferBytes: (options.bufferMb ?? 256) * 1024 * 1024,
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
        } catch (e) {
            core.warning(
                `${this.getLogPrefix()} Stale temp cleanup failed (non-fatal): ${
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
                await this.mountImageReadWrite();
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
            throw this.wrapError("create empty BTRFS cache", error);
        }
    }

    async save(): Promise<void> {
        try {
            await this.discoverMountInfo();
        } catch {
            this.logInfo("No BTRFS mount found — skipping save");
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
        await this.image.mountRO(this.mountPoint);

        try {
            await this.bindMountPaths(true);
        } catch (error) {
            await this.image.umountSafe(this.mountPoint);
            await this.image.cleanupLoopDevices(imageFile);
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

    private async copyAndMountReadWrite(imageFile: string): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        const localCopy = path.join(tempDir, "cache.btrfs");

        this.logInfo(`Copying for RW mount: ${imageFile} → ${localCopy}`);
        await fs.copyFile(imageFile, localCopy);

        // Randomize UUID so kernel doesn't reject duplicate of node-local original
        await this.image.randomizeUuid();

        this.containerFile = localCopy;
        this.image.setImageFile(localCopy);
        await this.mountImageReadWrite();
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
