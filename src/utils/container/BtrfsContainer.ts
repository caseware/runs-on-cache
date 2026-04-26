import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs/promises";
import * as path from "path";

import { createCacheKeySpecificTempDirectory } from "../actionUtils";
import { Container, ContainerOptions } from "./Container";
import { NodeLocalCache } from "./NodeLocalCache";

const MOUNT_TIMEOUT_MS = 30_000;
const MIN_DISK_HEADROOM_MB = 1024;

export class BtrfsContainer extends Container {
    public requiresCreateEmptyCache = true;
    public requiresKeepArchive = true;

    /**
     * The mount point for the BTRFS filesystem
     *
     * This is a temporary directory where the BTRFS image will be mounted, the actual paths to cache will be bind-mounted.
     */
    private mountPoint: string | undefined;

    private fsSize: string;
    private bufferBytes: number;
    private saveCompressionLevel: string;
    private readonly mountMode: "ro" | "rw";
    private readonly nodeLocal: NodeLocalCache;

    /**
     * Tracks whether restore used a node-local image (skip S3 upload on save).
     */
    private restoredFromNodeLocal = false;

    /**
     * Detected at discoverMountInfo() time — true if the current BTRFS mount is read-only.
     */
    private mountIsReadOnly = false;

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
            // Default to zstd default with compression level 3.
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
        this.bufferBytes = (options.bufferMb ?? 512) * 1024 * 1024; // Convert MB to bytes
        // Use higher compression for save (upload) to minimize image size.
        // Restore decompresses on-demand, so higher save compression = smaller image + same read perf.
        this.saveCompressionLevel = options.saveCompressionLevel || "zstd:9";
        this.mountMode = options.mountMode || "rw";
        this.nodeLocal = new NodeLocalCache(
            options.nodeLocalCacheDir || "",
            cacheKey,
            ".btrfs"
        );

        // Security input validations
        this.checkPathTraversal(this.baseDir, this.containerFile);
        this.pathsToCache.forEach(pathToCheck =>
            this.checkPathTraversal(this.baseDir, pathToCheck)
        );

        // Validate fsSize format to prevent command injection
        if (!/^[0-9]+[KMGT]?$/.test(this.fsSize)) {
            throw new Error(
                `Invalid filesystem size format: ${this.fsSize}. Must be a number followed by optional K, M, G, or T.`
            );
        }

        // Validate compression level
        const compressionRegex = /^(zlib(?:[:][1-9])?|lzo|zstd(?::-?(?:[0-9]|1[0-5]))?)$/;
        if (this.compressionLevel && !compressionRegex.test(this.compressionLevel)) {
            throw new Error(
                `Invalid compression level format: ${this.compressionLevel}. Must be 'zlib:<level>' where <level> is between 1 and 9, lzo, or zstd:<level> where <level> is between -15 and 15.`
            );
        }
        if (!compressionRegex.test(this.saveCompressionLevel)) {
            throw new Error(
                `Invalid save compression level format: ${this.saveCompressionLevel}. Must be 'zlib:<level>', lzo, or zstd:<level>.`
            );
        }
    }

    isSupportedMethod(method?: string): boolean {
        return (method?.split("-")[0] || method) === "btrfs";
    }

    async initialize(): Promise<void> {
        try {
            await this.checkPrerequisites();
            // Clean up stale temp files at the start of every job
            await this.nodeLocal.cleanupStaleTempFiles();
        } catch (e) {
            core.setFailed((e as Error).message);
            process.exit(1);
        }
    }

    // Override the log prefix for BTRFS-specific logging
    protected getLogPrefix(): string {
        return "[BTRFS]";
    }

    // ── Node-local restore (hot path) ────────────────────────────────

    /**
     * Check if a node-local BTRFS image exists for this cache key.
     * This is the fast path: mount directly from the node's HostPath volume (~1-2s).
     */
    async tryRestoreFromNodeLocal(): Promise<boolean> {
        if (!this.nodeLocal.enabled) return false;

        const localExists = await this.nodeLocal.exists();
        if (!localExists) return false;

        const localPath = this.nodeLocal.localPath;
        this.logInfo(`Node-local cache hit — mounting from ${localPath}`);

        // Verify integrity before mounting
        const isHealthy = await this.verifyImageIntegrity(localPath);
        if (!isHealthy) {
            this.logInfo("Node-local image corrupted — falling back to S3");
            return false;
        }

        try {
            if (this.mountMode === "rw") {
                // Copy to job-local location before mounting read-write
                await this.copyAndMountReadWrite(localPath);
            } else {
                // Mount read-only directly from the shared node-local image
                await this.mountReadOnly(localPath);
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

    /**
     * Mount a BTRFS image read-only and bind-mount paths to the workspace.
     * Used for node_modules and other immutable caches.
     */
    private async mountReadOnly(imageFile: string): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(this.cacheKey);
        this.mountPoint = path.join(tempDir, "mount");

        await fs.mkdir(this.mountPoint, { recursive: true });
        this.logInfo(`Mounting read-only: ${imageFile} → ${this.mountPoint}`);

        await this.mountWithErrorHandling(
            imageFile,
            this.mountPoint,
            ["loop", "ro", `compress=${this.compressionLevel}`]
        );

        try {
            // Bind-mount each path read-only to the workspace
            await this.bindMountPaths(true);
        } catch (error) {
            // If bind-mount fails, unmount the BTRFS image to avoid a dangling RO mount
            // that would confuse the save step's discoverMountInfo()
            await this.umountWithErrorHandling(this.mountPoint);
            await this.cleanupLoopDevices(imageFile);
            this.mountPoint = undefined;
            throw error;
        }

        await this.checkFilesystemHealth();
    }

    /**
     * Copy the BTRFS image to a job-local temp directory, then mount read-write.
     * Used for mutable caches (e.g., sparse git repos).
     */
    private async copyAndMountReadWrite(imageFile: string): Promise<void> {
        const tempDir = await createCacheKeySpecificTempDirectory(this.cacheKey);
        const localCopy = path.join(tempDir, "cache.btrfs");

        this.logInfo(`Copying for RW mount: ${imageFile} → ${localCopy}`);
        await fs.copyFile(imageFile, localCopy);

        // Update containerFile to the local copy so save() operates on the right file
        this.containerFile = localCopy;
        await this.mount();
    }

    // ── Standard restore (S3 download path) ──────────────────────────

    async restore(): Promise<void> {
        try {
            // Verify image integrity before mounting
            const isHealthy = await this.verifyImageIntegrity(
                this.containerFile
            );
            if (!isHealthy) {
                this.logInfo(
                    "Corrupted image detected — falling back to empty cache"
                );
                return this.createEmptyCache();
            }

            if (this.mountMode === "ro") {
                // Mount the downloaded image read-only
                await this.mountReadOnly(this.containerFile);
            } else {
                // Standard read-write mount
                await this.mount();
                await this.checkFilesystemHealth();
            }
        } catch (error) {
            // Clean up any leaked loop devices
            await this.cleanupLoopDevices(this.containerFile);
            throw this.wrapError("restore BTRFS cache", error);
        }
    }

    async createEmptyCache(): Promise<void> {
        try {
            // Calculate optimal sparse file size based on available disk space
            const effectiveSize = await this.calculateSparseSize();

            // Create new empty cache image
            this.logInfo(`Creating sparse image: ${this.containerFile} (virtual size: ${effectiveSize})`);
            await exec.exec("truncate", [
                "-s",
                effectiveSize,
                this.containerFile
            ]);

            // Format with BTRFS
            this.logInfo(`Formatting image with BTRFS`);
            await exec.exec("mkfs.btrfs", ["-f", this.containerFile], {
                silent: !core.isDebug()
            });

            // Mount the filesystem so workspace operations write directly to it
            return this.mount();
        } catch (error) {
            // Clean up loop devices on failure
            await this.cleanupLoopDevices(this.containerFile);
            throw this.wrapError("create empty BTRFS cache", error);
        }
    }

    async save(): Promise<void> {
        // Discover all mount information once
        try {
            await this.discoverMountInfo();
        } catch {
            // No BTRFS mount found — restore likely failed, nothing to save
            this.logInfo("No BTRFS mount found — skipping save");
            return;
        }

        if (!this.mountPoint) {
            this.logInfo("Mount point not discovered — skipping save");
            return;
        }

        // Read-only mount means nothing changed — skip save
        if (this.mountIsReadOnly) {
            this.logInfo("Skipping save — mount is read-only, nothing to persist");
            return;
        }

        // Remount with higher compression before defrag so rewritten blocks use save-level compression.
        // btrfs defrag -c only sets the algorithm (zstd/lzo/zlib), not the level.
        // The actual compression level comes from the mount option, so we remount with compress-force=<saveLevel>.
        const defragAlgo = this.saveCompressionLevel.split(":")[0];
        this.logInfo(`Remounting with compress-force=${this.saveCompressionLevel} before defrag`);
        try {
            await exec.exec(
                "sudo",
                ["mount", "-o", `remount,compress-force=${this.saveCompressionLevel}`, this.mountPoint]
            );
        } catch (remountError) {
            core.warning(
                `Remount with save compression failed, defrag will use mount-time level: ${
                    remountError instanceof Error ? remountError.message : remountError
                }`
            );
        }

        this.logInfo(`Defragmenting + recompressing with ${defragAlgo} (save-compression-level: ${this.saveCompressionLevel})`);
        try {
            await exec.exec(
                "sudo",
                ["btrfs", "filesystem", "defragment", "-r", `-c${defragAlgo}`, this.mountPoint]
            );
        } catch (defragError) {
            core.warning(
                `Defrag failed (image will upload at mount-time compression): ${
                    defragError instanceof Error ? defragError.message : defragError
                }`
            );
        }

        this.logDebug(`Syncing and calculating used space`);
        await exec.exec("sync", [], { silent: !core.isDebug() });

        // Get used space and resize filesystem
        let usedBytes = 0;
        try {
            const usageOutput = await this.getBtrfsUsage();
            usedBytes = this.parseUsedBytes(usageOutput);
        } catch (error) {
            core.warning(
                `Could not determine exact usage, using default buffer: ${error}`
            );
            usedBytes = 512 * 1024 * 1024; // 512MB default
        }

        const targetSize = usedBytes + this.bufferBytes;
        const targetMb = Math.max(1, Math.ceil(targetSize / (1024 * 1024))); // Ensure minimum 1MB

        core.debug(`Used: ${usedBytes} bytes, Resizing to ${targetMb} MB`);
        await exec.exec(
            "sudo",
            ["btrfs", "filesystem", "resize", `${targetMb}M`, this.mountPoint],
            { silent: !core.isDebug() }
        );

        // Ensure all changes are written to disk before unmounting
        await exec.exec("sync", [], { silent: !core.isDebug() });

        // Unmount filesystem - the containerFile now points to the actual file with all data
        await this.unmount();

        // Resize backing file
        this.logDebug(`Resizing backing file to ${targetMb} MB`);
        await exec.exec("truncate", ["-s", `${targetMb}M`, this.containerFile]);

        // Additional sync and wait after unmount to ensure file is fully accessible
        await exec.exec("sync", [], { silent: !core.isDebug() });

        // Clean up loop devices after save
        await this.cleanupLoopDevices(this.containerFile);

        this.logDebug(
            `Save completed. Container file ready for upload: ${this.containerFile}`
        );
    }

    /**
     * Whether the S3 upload should be skipped because the node already has the image.
     */
    shouldSkipS3Upload(): boolean {
        return this.mountIsReadOnly;
    }

    async getNodeLocalDownloadPath(): Promise<string | null> {
        return this.nodeLocal.getDownloadPath();
    }

    async commitNodeLocalDownload(tempPath: string): Promise<boolean> {
        return this.nodeLocal.commitTempFile(tempPath);
    }

    isNodeLocalEnabled(): boolean {
        return this.nodeLocal.enabled;
    }

    // ── Private helpers ──────────────────────────────────────────────

    private async execWithOutput(
        command: string,
        args: string[]
    ): Promise<string> {
        let output = "";
        await exec.exec(command, args, {
            listeners: {
                stdout: (data: Buffer) => {
                    output += data.toString();
                }
            },
            silent: !core.isDebug()
        });
        return output.trim();
    }

    private async mountWithErrorHandling(
        device: string,
        mountPath: string,
        options?: string[],
        useSudo = true
    ): Promise<void> {
        const mountArgs = [device, mountPath];
        if (options && options.length > 0) {
            mountArgs.unshift("-o", options.join(","));
        }

        const command = useSudo ? "sudo" : "mount";
        const args = useSudo ? ["mount", ...mountArgs] : mountArgs;

        try {
            await this.execWithTimeout(
                () =>
                    exec.exec(command, args, { silent: !core.isDebug() }),
                MOUNT_TIMEOUT_MS,
                `mount ${device} at ${mountPath}`
            );
        } catch (error) {
            // On mount failure, clean up any loop device that may have been allocated
            await this.cleanupLoopDevices(device);
            throw this.wrapError(`mount ${device} at ${mountPath}`, error);
        }
    }

    private async execSudo(
        command: string,
        args: string[] = []
    ): Promise<void> {
        await exec.exec("sudo", [command, ...args], {
            silent: !core.isDebug()
        });
    }

    private async umountWithErrorHandling(mountPath: string): Promise<void> {
        try {
            await this.execSudo("umount", [mountPath]);
        } catch (error) {
            core.warning(
                `${this.getLogPrefix()} Failed to umount ${mountPath}: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    /**
     * Execute a promise with a timeout. If the operation exceeds the timeout,
     * reject with a descriptive error.
     */
    private async execWithTimeout<T>(
        fn: () => Promise<T>,
        timeoutMs: number,
        description: string
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(
                    new Error(
                        `${this.getLogPrefix()} Operation timed out after ${timeoutMs}ms: ${description}`
                    )
                );
            }, timeoutMs);

            fn().then(
                result => {
                    clearTimeout(timer);
                    resolve(result);
                },
                err => {
                    clearTimeout(timer);
                    reject(err);
                }
            );
        });
    }

    /**
     * Clean up any loop devices associated with a given file.
     * Prevents loop device leaks when mount fails partway through.
     */
    private async cleanupLoopDevices(imageFile: string): Promise<void> {
        try {
            const output = await this.execWithOutput("losetup", [
                "-j",
                imageFile
            ]);
            if (!output) return;

            // Output format: /dev/loop0: [0050]:12345 (/path/to/file)
            const devices = output
                .split("\n")
                .map(line => line.split(":")[0])
                .filter(d => d.startsWith("/dev/loop"));

            for (const device of devices) {
                this.logDebug(`Cleaning up leaked loop device: ${device}`);
                try {
                    await this.execSudo("losetup", ["-d", device]);
                } catch {
                    core.warning(
                        `${this.getLogPrefix()} Failed to detach loop device ${device}`
                    );
                }
            }
        } catch {
            // losetup -j may fail if no loop devices exist; that's fine
        }
    }

    /**
     * Check available disk space and warn or fail if insufficient.
     * Returns available space in bytes.
     */
    private async checkDiskSpace(targetPath: string): Promise<number> {
        try {
            const output = await this.execWithOutput("df", [
                "--output=avail",
                "-B1",
                targetPath
            ]);
            const lines = output.split("\n");
            // Skip header line
            const availStr = lines[lines.length - 1]?.trim();
            if (availStr) {
                const availBytes = parseInt(availStr, 10);
                const availMb = Math.floor(availBytes / (1024 * 1024));
                this.logDebug(`Available disk space: ${availMb} MB`);

                if (availMb < MIN_DISK_HEADROOM_MB) {
                    core.warning(
                        `${this.getLogPrefix()} Low disk space: ${availMb} MB available ` +
                            `(minimum recommended: ${MIN_DISK_HEADROOM_MB} MB). ` +
                            `BTRFS operations may fail.`
                    );
                }
                return availBytes;
            }
        } catch {
            this.logDebug("Could not check disk space (non-critical)");
        }
        return 0;
    }

    /**
     * Calculate the optimal sparse file size based on available disk space.
     * Uses the smaller of: configured fsSize or 80% of available disk.
     * The sparse file only consumes actual written bytes, so this is a virtual ceiling.
     */
    private async calculateSparseSize(): Promise<string> {
        const availBytes = await this.checkDiskSpace(
            path.dirname(this.containerFile)
        );

        if (availBytes === 0) {
            // Couldn't determine disk space; use configured size
            return this.fsSize;
        }

        // Parse configured fsSize to bytes
        const configuredBytes = this.parseSizeToBytes(this.fsSize);

        // Use 80% of available space as the virtual ceiling
        const safeMaxBytes = Math.floor(availBytes * 0.8);

        if (configuredBytes > safeMaxBytes && safeMaxBytes > 0) {
            const safeSizeGb = Math.max(
                1,
                Math.floor(safeMaxBytes / (1024 * 1024 * 1024))
            );
            this.logInfo(
                `Reducing sparse file size from ${this.fsSize} to ${safeSizeGb}G ` +
                    `(80% of ${Math.floor(availBytes / (1024 * 1024 * 1024))}G available)`
            );
            return `${safeSizeGb}G`;
        }

        return this.fsSize;
    }

    private parseSizeToBytes(size: string): number {
        const match = size.match(/^(\d+)([KMGT])?$/);
        if (!match) return 0;

        let bytes = parseInt(match[1], 10);
        switch (match[2]) {
            case "K":
                bytes *= 1024;
                break;
            case "M":
                bytes *= 1024 * 1024;
                break;
            case "G":
                bytes *= 1024 * 1024 * 1024;
                break;
            case "T":
                bytes *= 1024 * 1024 * 1024 * 1024;
                break;
        }
        return bytes;
    }

    /**
     * Verify the integrity of a downloaded BTRFS image before mounting.
     * Runs `btrfs check --readonly` to detect corruption.
     * Returns true if the image is healthy, false if corrupted.
     */
    private async verifyImageIntegrity(imageFile: string): Promise<boolean> {
        try {
            this.logDebug(`Checking image integrity: ${imageFile}`);
            await exec.exec("sudo", ["btrfs", "check", "--readonly", imageFile], {
                silent: !core.isDebug()
            });
            this.logDebug("Image integrity check passed");
            return true;
        } catch (error) {
            core.warning(
                `${this.getLogPrefix()} Image integrity check failed for ${imageFile}: ${
                    error instanceof Error ? error.message : error
                }. Will recreate cache from scratch.`
            );
            return false;
        }
    }

    /**
     * Check filesystem health after mounting by reading device stats.
     * Reports any I/O errors detected by BTRFS.
     */
    private async checkFilesystemHealth(): Promise<void> {
        if (!this.mountPoint) return;

        try {
            const output = await this.execWithOutput("sudo", [
                "btrfs",
                "device",
                "stats",
                this.mountPoint
            ]);

            // Parse stats: look for non-zero error counters
            const errorLines = output
                .split("\n")
                .filter(line => {
                    const match = line.match(/\.(\w+_errs)\s+(\d+)/);
                    return match && parseInt(match[2], 10) > 0;
                });

            if (errorLines.length > 0) {
                core.warning(
                    `${this.getLogPrefix()} Filesystem has I/O errors:\n${errorLines.join("\n")}` +
                        `\nConsider recreating the cache image.`
                );
            } else {
                this.logDebug("Filesystem health check: no errors detected");
            }
        } catch {
            this.logDebug("Could not check filesystem health (non-critical)");
        }
    }

    private checkPathTraversal(base: string, pathToCheck: string): void {
        // Validate that the resolved path is within the base directory
        const absBase = path.resolve(base);
        const absPathToCheck = path.resolve(path.join(base, pathToCheck));
        if (!absPathToCheck.startsWith(absBase)) {
            throw new Error(
                `Path traversal detected: ${pathToCheck} resolves outside base directory`
            );
        }
    }

    private async checkPrerequisites(): Promise<void> {
        if (process.platform !== "linux") {
            throw new Error(
                `BTRFS compression is only supported on Linux platforms. ` +
                    `Current platform: ${process.platform}. ` +
                    `Please use a different compression method or switch to a Linux runner.`
            );
        }

        const requiredTools = [
            { command: "truncate", description: "creating sparse files" },
            {
                command: "mkfs.btrfs",
                description: "creating BTRFS filesystems (install btrfs-progs)"
            },
            {
                command: "btrfs",
                description: "BTRFS filesystem operations (install btrfs-progs)"
            },
            {
                command: "findmnt",
                description: "finding mounted filesystems (install util-linux)"
            },
            {
                command: "sudo",
                description: "elevated privileges for mounting operations"
            }
        ];

        const missingTools: string[] = [];
        await Promise.all(
            requiredTools.map(async tool => {
                try {
                    await exec.exec("which", [tool.command], {
                        silent: !core.isDebug()
                    });
                } catch (error) {
                    missingTools.push(`${tool.command} (${tool.description})`);
                }
            })
        );

        if (missingTools.length > 0) {
            throw new Error(
                `Missing required tools for BTRFS compression: ${missingTools.join(
                    ", "
                )}. ` +
                    `Please install the missing tools or use a different compression method.`
            );
        }

        // Check if sudo works without password prompt (for CI environments)
        try {
            await exec.exec("sudo", ["-n", "true"], {
                silent: !core.isDebug()
            });
        } catch (error) {
            throw new Error(
                `sudo access is required for BTRFS mounting operations but sudo is not available or requires a password. ` +
                    `Please ensure the runner has passwordless sudo access or use a different compression method.`
            );
        }
    }

    private async getBtrfsUsage(): Promise<string> {
        if (!this.mountPoint) {
            throw new Error("Mount point is not set");
        }
        return this.execWithOutput("sudo", [
            "btrfs",
            "filesystem",
            "usage",
            "-b",
            this.mountPoint
        ]);
    }

    private parseUsedBytes(usageOutput: string): number {
        const lines = usageOutput.split("\n");
        for (const line of lines) {
            const match = line.match(/^\s*Used:\s*(\d+)$/);
            if (match) {
                return parseInt(match[1], 10);
            }
        }
        throw new Error("Could not parse BTRFS usage output");
    }

    private async discoverMountInfo(): Promise<void> {
        // Get the expected temp directory for this cache key
        const tempDir = await createCacheKeySpecificTempDirectory(
            this.cacheKey
        );
        const expectedMountPoint = path.join(tempDir, "mount");

        this.logDebug(`Looking for BTRFS mount at: ${expectedMountPoint}`);

        // Use findmnt to find BTRFS mounts with target, source, and options
        const output = await this.execWithOutput("findmnt", [
            "-t",
            "btrfs",
            "-n",
            "-o",
            "TARGET,SOURCE,OPTIONS"
        ]);
        this.logDebug(`findmnt output:\n${output}`);

        // Parse findmnt output: TARGET SOURCE OPTIONS
        const lines = output.split("\n");
        for (const line of lines) {
            if (line.trim() === "") continue;

            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const mountPoint = parts[0];
                const device = parts[1];
                const options = parts.slice(2).join(" ");

                // Look for our specific mount point
                if (mountPoint === expectedMountPoint) {
                    this.logDebug(
                        `Found existing mount: ${device} → ${mountPoint} (${options})`
                    );

                    this.mountPoint = mountPoint;
                    this.mountIsReadOnly = /\bro\b/.test(options);

                    // With deterministic temp directories, containerFile should already be correct
                    this.logDebug(`Using containerFile: ${this.containerFile} (readOnly=${this.mountIsReadOnly})`);

                    return;
                }
            }
        }

        throw new Error(
            `No BTRFS cache filesystem found for cache key ${this.cacheKey}. ` +
                `Expected mount at: ${expectedMountPoint}. ` +
                `Make sure the cache was properly initialized and mounted first.`
        );
    }

    /**
     * Mount the BTRFS image read-write (standard mode for population/save).
     */
    private async mount(): Promise<void> {
        try {
            const tempDir = await createCacheKeySpecificTempDirectory(
                this.cacheKey
            );
            this.mountPoint = path.join(tempDir, "mount");

            // Create mount point and mount the image
            await fs.mkdir(this.mountPoint, { recursive: true });
            core.debug(`[BTRFS] Mounting image to ${this.mountPoint}`);
            await this.mountWithErrorHandling(
                this.containerFile,
                this.mountPoint,
                ["loop", "rw", `compress=${this.compressionLevel}`]
            );

            // Bind-mount each path so workspace points to BTRFS (read-write)
            await this.bindMountPaths(false);
        } catch (error) {
            // Clean up loop devices on mount failure
            await this.cleanupLoopDevices(this.containerFile);
            throw new Error(
                `Failed to mount BTRFS filesystem: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    /**
     * Bind-mount each cached path from the BTRFS mount to the workspace.
     * @param readOnly If true, bind mounts are remounted read-only after initial bind.
     */
    private async bindMountPaths(readOnly: boolean): Promise<void> {
        const promises = this.pathsToCache.map(async p => {
            if (!this.mountPoint) {
                throw new Error("Mount point is not set");
            }

            const absPath = path.join(this.baseDir, p);
            const btrfsPath = path.join(this.mountPoint, p);

            core.debug(`[BTRFS] Bind-mounting ${btrfsPath} → ${absPath}${readOnly ? " (ro)" : ""}`);

            try {
                if (readOnly) {
                    // Read-only mount: BTRFS path must already exist in the image.
                    // Only create the workspace target — never write to the RO filesystem.
                    try {
                        await exec.exec("test", ["-d", btrfsPath], {
                            ignoreReturnCode: false,
                            silent: !core.isDebug()
                        });
                    } catch {
                        throw new Error(
                            `Source path ${btrfsPath} does not exist in BTRFS image`
                        );
                    }
                    await this.execSudo("mkdir", ["-p", absPath]);
                    const parentDir = path.dirname(absPath);
                    await this.execSudo("chown", [
                        "--reference",
                        parentDir,
                        absPath
                    ]);
                } else {
                    // Read-write mount: create directories on both sides
                    await Promise.all([
                        this.execSudo("mkdir", ["-p", btrfsPath]),
                        this.execSudo("mkdir", ["-p", absPath])
                    ]);
                    const parentDir = path.dirname(absPath);
                    await Promise.all([
                        this.execSudo("chown", [
                            "--reference",
                            parentDir,
                            absPath
                        ]),
                        this.execSudo("chown", [
                            "--reference",
                            this.baseDir,
                            btrfsPath
                        ])
                    ]);
                }

                // Bind mount: workspace points to BTRFS
                await this.mountWithErrorHandling(btrfsPath, absPath, [
                    "bind"
                ]);

                // Remount read-only if requested
                if (readOnly) {
                    await this.mountWithErrorHandling(btrfsPath, absPath, [
                        "bind",
                        "remount",
                        "ro"
                    ]);
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

    private async unmount(): Promise<void> {
        if (!this.mountPoint) {
            throw new Error("Mount point is not set");
        }

        try {
            await exec.exec("sync", [], { silent: !core.isDebug() });

            // First unmount all bind mounts
            for (const p of this.pathsToCache) {
                const absPath = path.join(this.baseDir, p);
                try {
                    const bindMountCheck = await exec.exec(
                        "mountpoint",
                        [absPath],
                        {
                            ignoreReturnCode: true,
                            silent: !core.isDebug()
                        }
                    );
                    if (bindMountCheck === 0) {
                        core.debug(`[BTRFS] Unmounting bind mount: ${absPath}`);
                        await this.umountWithErrorHandling(absPath);
                    }
                } catch (error) {
                    core.debug(
                        `Failed to unmount bind mount ${absPath}: ${error}`
                    );
                }
            }

            // Then unmount the main BTRFS filesystem
            const mountCheck = await exec.exec(
                "mountpoint",
                [this.mountPoint],
                {
                    ignoreReturnCode: true,
                    silent: !core.isDebug()
                }
            );

            if (mountCheck === 0) {
                core.debug(
                    `[BTRFS] Unmounting main filesystem: ${this.mountPoint}`
                );
                await this.umountWithErrorHandling(this.mountPoint);
            }
        } catch (error) {
            core.debug(`Cleanup mount failed (non-critical): ${error}`);
        }

        try {
            await fs.rm(this.mountPoint, { recursive: true, force: true });
        } catch (error) {
            core.debug(`Cleanup mount point failed (non-critical): ${error}`);
        }
    }
}
