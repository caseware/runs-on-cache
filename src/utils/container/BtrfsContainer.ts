import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs/promises";
import path from "path";
import { Container, ContainerOptions } from "./Container";

export class BtrfsContainer extends Container {
    public requiresCreateEmptyCache = true;

    /**
     * The mount point for the BTRFS filesystem
     *
     * This is a temporary directory where the BTRFS image will be mounted, the actual paths to cache will be bind-mounted.
     */
    private mountPoint = "";

    private fsSize: string;
    private bufferBytes: number;

    constructor(
        containerFile: string,
        compressionMethod: string,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerOptions
    ) {
        super(containerFile, compressionMethod, baseDir, pathsToCache, cacheKey, options);
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
    }

    isSupportedMethod(method?: string): boolean {
        return (method?.split('-')[0] || method) === "btrfs";
    }

    async initialize(): Promise<void> {
        try {
            await this.checkPrerequisites();
        } catch (e) {
            core.setFailed((e as Error).message);
            process.exit(1);
        }
    }

    async createEmptyCache(): Promise<void> {
        try {
            // Create new empty cache image
            core.info(`[BTRFS] Creating sparse image: ${this.containerFile}`);
            await exec.exec("truncate", ["-s", this.fsSize, this.containerFile]);

            // Format with BTRFS
            core.info(`[BTRFS] Formatting image with BTRFS`);
            await exec.exec("mkfs.btrfs", ["-f", this.containerFile], {
                silent: !core.isDebug()
            });

            // Mount the filesystem so workspace operations write directly to it
            return this.mount();
        } catch (error) {
            throw new Error(`Failed to create empty BTRFS cache: ${error instanceof Error ? error.message : error}`);
        }
    }

    async restore(): Promise<void> {
        try {
            return this.mount();
        } catch (error) {
            throw new Error(`Failed to restore BTRFS cache: ${error instanceof Error ? error.message : error}`);
        }
    }

    async save(): Promise<void> {
        // Find the existing mount point for this image
        this.mountPoint = await this.findExistingMountPoint();

        core.debug(`[BTRFS] Defragmenting filesystem`);
        await exec.exec("btrfs", ["filesystem", "defragment", "-r", this.mountPoint], { silent: !core.isDebug() });

        core.debug(`[BTRFS] Syncing and calculating used space`);
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
        await exec.exec("sudo", [
            "btrfs",
            "filesystem",
            "resize",
            `${targetMb}M`,
            this.mountPoint
        ], { silent: !core.isDebug() });

        // Unmount
        await this.unmount();
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
                command: "sudo",
                description: "elevated privileges for mounting operations"
            }
        ];

        const missingTools: string[] = [];
        await Promise.all(
            requiredTools.map(async tool => {
                try {
                    await exec.exec("which", [tool.command], { silent: !core.isDebug() });
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
            await exec.exec("sudo", ["-n", "true"], { silent: !core.isDebug() });
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
        let output = "";
        await exec.exec(
            "sudo",
            ["btrfs", "filesystem", "usage", "-b", this.mountPoint],
            {
                listeners: {
                    stdout: (data: Buffer) => {
                        output += data.toString();
                    }
                }
            }
        );
        return output;
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

    private async findExistingMountPoint(): Promise<string> {
        let output = "";
        await exec.exec("mount", [], {
            listeners: {
                stdout: (data: Buffer) => {
                    output += data.toString();
                }
            },
            silent: !core.isDebug()
        });

        // Create the expected directory pattern using the cache key
        const safeKey = this.cacheKey.replace(/[^a-zA-Z0-9\-_.]/g, '_');
        const expectedPattern = `btrfs-cache-${safeKey}`;

        core.debug(`[BTRFS] Looking for mount pattern: ${expectedPattern}`);
        core.debug(`[BTRFS] Mount output:\n${output}`);

        // Look for BTRFS filesystem mounted in our cache-key specific directory
        const lines = output.split("\n");
        for (const line of lines) {
            // Look for lines with our cache pattern and type btrfs
            if (line.includes(expectedPattern) && line.includes("type btrfs")) {
                const match = line.match(/^(.+\.btrfs) on (.+) type btrfs/);
                if (match) {
                    const mountedImageFile = match[1];
                    const mountPoint = match[2];
                    core.debug(`[BTRFS] Found existing mount: ${mountedImageFile} → ${mountPoint}`);
                    
                    // Update our containerFile to match the actually mounted one
                    this.containerFile = mountedImageFile;
                    return mountPoint;
                }
            }
        }

        throw new Error(
            `No BTRFS cache filesystem found for cache key ${this.cacheKey} (pattern: ${expectedPattern}). ` +
            `Make sure the cache was properly initialized and mounted first.`
        );
    }

    private async mount(): Promise<void> {
        try {
            this.mountPoint = await this.createCacheKeySpecificTempDirectory();
            
            // Create mount point and mount the image
            await fs.mkdir(this.mountPoint, { recursive: true });
            core.debug(`[BTRFS] Mounting image to ${this.mountPoint}`);
            await exec.exec("sudo", [
                "mount",
                "-o",
                "loop,rw,compress=zstd",
                this.containerFile,
                this.mountPoint
            ], { silent: !core.isDebug() });

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
                        exec.exec("sudo", ["mkdir", "-p", btrfsPath], { silent: !core.isDebug() }),
                        exec.exec("sudo", ["mkdir", "-p", absPath], { silent: !core.isDebug() })
                    ]);
                    
                    // Set ownership to match the workspace directory
                    const parentDir = path.dirname(absPath);
                    await Promise.all([
                        exec.exec("sudo", ["chown", "--reference", parentDir, absPath], { silent: !core.isDebug() }),
                        exec.exec("sudo", ["chown", "--reference", this.baseDir, btrfsPath], { silent: !core.isDebug() })
                    ]);

                    // Bind mount: workspace points to BTRFS
                    await exec.exec("sudo", ["mount", "--bind", btrfsPath, absPath], { silent: !core.isDebug() });
                } catch (error) {
                    throw new Error(`Failed to bind-mount ${btrfsPath} to ${absPath}: ${error instanceof Error ? error.message : error}`);
                }
            });
            await Promise.all(promises);
        } catch (error) {
            throw new Error(`Failed to mount BTRFS filesystem: ${error instanceof Error ? error.message : error}`);
        }
    }

    private async createCacheKeySpecificTempDirectory(): Promise<string> {
        // Use the cache key directly in the directory name
        // Replace invalid filesystem characters with underscores
        const safeKey = this.cacheKey.replace(/[^a-zA-Z0-9\-_.]/g, '_');
        
        const baseTempDir = await utils.createTempDirectory();
        const cacheSpecificDir = path.join(baseTempDir, `btrfs-cache-${safeKey}`);
        
        await fs.mkdir(cacheSpecificDir, { recursive: true });
        core.debug(`[BTRFS] Created cache-specific directory: ${cacheSpecificDir} for key: ${this.cacheKey}`);
        
        return cacheSpecificDir;
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
                        await exec.exec("sudo", ["umount", absPath], { silent: !core.isDebug() });
                    }
                } catch (error) {
                    core.debug(`Failed to unmount bind mount ${absPath}: ${error}`);
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
                core.debug(`[BTRFS] Unmounting main filesystem: ${this.mountPoint}`);
                await exec.exec("sudo", ["umount", this.mountPoint], { silent: !core.isDebug() });
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
