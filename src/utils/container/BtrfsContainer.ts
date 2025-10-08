import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs/promises";
import * as path from "path";

import { createCacheKeySpecificTempDirectory } from "../actionUtils";
import { Container, ContainerOptions } from "./Container";

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
        this.bufferBytes = (options.bufferMb || 512) * 1024 * 1024; // Convert MB to bytes

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
        if (
            this.compressionLevel &&
            // List of supported compressions: https://btrfs.readthedocs.io/en/latest/Compression.html
            !/^(zlib(?:[:][1-9])?|lzo|zstd(?::-?(?:[0-9]|1[0-5]))?)$/.test(
                this.compressionLevel
            )
        ) {
            throw new Error(
                `Invalid compression level format: ${this.compressionLevel}. Must be 'zlib:<level>' where <level> is between 1 and 9, lzo, or zstd:<level> where <level> is between -15 and 15.`
            );
        }
    }

    isSupportedMethod(method?: string): boolean {
        return (method?.split("-")[0] || method) === "btrfs";
    }

    async initialize(): Promise<void> {
        try {
            await this.checkPrerequisites();
        } catch (e) {
            core.setFailed((e as Error).message);
            process.exit(1);
        }
    }

    // Override the log prefix for BTRFS-specific logging
    protected getLogPrefix(): string {
        return "[BTRFS]";
    }

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
            await exec.exec(command, args, { silent: !core.isDebug() });
        } catch (error) {
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

    async createEmptyCache(): Promise<void> {
        try {
            // Create new empty cache image
            this.logInfo(`Creating sparse image: ${this.containerFile}`);
            await exec.exec("truncate", [
                "-s",
                this.fsSize,
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
            throw this.wrapError("create empty BTRFS cache", error);
        }
    }

    async restore(): Promise<void> {
        try {
            return this.mount();
        } catch (error) {
            throw this.wrapError("restore BTRFS cache", error);
        }
    }

    async save(): Promise<void> {
        // Discover all mount information once
        await this.discoverMountInfo();

        if (!this.mountPoint) {
            throw this.createError("Mount point not discovered");
        }

        this.logDebug(`Defragmenting filesystem`);
        await exec.exec(
            "btrfs",
            ["filesystem", "defragment", "-r", this.mountPoint],
            { silent: !core.isDebug() }
        );

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

        this.logDebug(
            `Save completed. Container file ready for upload: ${this.containerFile}`
        );
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

        // Use findmnt to find BTRFS mounts with both target and source
        const output = await this.execWithOutput("findmnt", [
            "-t",
            "btrfs",
            "-n",
            "-o",
            "TARGET,SOURCE"
        ]);
        this.logDebug(`findmnt output:\n${output}`);

        // Parse findmnt output: TARGET SOURCE
        const lines = output.split("\n");
        for (const line of lines) {
            if (line.trim() === "") continue;

            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const mountPoint = parts[0];
                const device = parts[1];

                // Look for our specific mount point
                if (mountPoint === expectedMountPoint) {
                    this.logDebug(
                        `Found existing mount: ${device} → ${mountPoint}`
                    );

                    this.mountPoint = mountPoint;

                    // With deterministic temp directories, containerFile should already be correct
                    this.logDebug(`Using containerFile: ${this.containerFile}`);

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

            // Bind-mount each path so workspace points to BTRFS
            const promises = this.pathsToCache.map(async p => {
                if (!this.mountPoint) {
                    throw new Error("Mount point is not set");
                }

                const absPath = path.join(this.baseDir, p);
                const btrfsPath = path.join(this.mountPoint, p);

                core.debug(`[BTRFS] Bind-mounting ${btrfsPath} → ${absPath}`);

                try {
                    await Promise.all([
                        this.execSudo("mkdir", ["-p", btrfsPath]),
                        this.execSudo("mkdir", ["-p", absPath])
                    ]);

                    // Set ownership to match the workspace directory
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

                    // Bind mount: workspace points to BTRFS
                    await this.mountWithErrorHandling(btrfsPath, absPath, [
                        "bind"
                    ]);
                } catch (error) {
                    throw new Error(
                        `Failed to bind-mount ${btrfsPath} to ${absPath}: ${
                            error instanceof Error ? error.message : error
                        }`
                    );
                }
            });
            await Promise.all(promises);
        } catch (error) {
            throw new Error(
                `Failed to mount BTRFS filesystem: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
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
