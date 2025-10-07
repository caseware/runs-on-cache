import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs/promises";
import path from "path";

export interface BtrfsOptions {
    fsSize: string;
    bufferMb?: number;
}

export class BtrfsCache {
    /**
     * The mount point for the BTRFS filesystem
     *
     * This is a temporary directory where the BTRFS image will be mounted, the actual paths to cache will be bind-mounted.
     */
    private mountPoint = "";

    private fsSize: string;
    private bufferBytes: number;
    private readonly imageFile: string;

    constructor(
        private readonly archivePath: string,
        private readonly baseDir: string,
        private readonly pathsToCache: string[],
        options: BtrfsOptions
    ) {
        this.fsSize = options.fsSize;
        this.bufferBytes = (options.bufferMb || 512) * 1024 * 1024; // Convert MB to bytes
        this.imageFile = this.archivePath.replace(/\.lz4$/, "");

        // Security input validations
        this.checkPathTraversal(this.baseDir, this.archivePath);
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

    async initialize(): Promise<void> {
        try {
            await this.checkPrerequisites();
        } catch (e) {
            core.setFailed((e as Error).message);
            process.exit(1);
        }

        this.mountPoint = await utils.createTempDirectory();
    }

    async createEmptyCache(): Promise<void> {
        // Create new empty cache image
        core.info(`[BTRFS] Creating sparse image: ${this.imageFile}`);
        await exec.exec("truncate", ["-s", this.fsSize, this.imageFile]);

        // Format with BTRFS
        core.info(`[BTRFS] Formatting image with BTRFS`);
        await exec.exec("mkfs.btrfs", ["-f", this.imageFile], {
            silent: true
        });

        return this.mount();
    }

    async restore(): Promise<void> {
        // Decompress existing cache
        core.info(
            `[BTRFS] Decompressing ${this.archivePath} → ${this.imageFile}`
        );
        await exec.exec("lz4", [
            "-d",
            "--rm",
            this.archivePath,
            this.imageFile
        ]);

        return this.mount();
    }

    async save(): Promise<void> {
        core.info(`[BTRFS] Syncing and calculating used space`);
        await exec.exec("sync");

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

        core.info(`→ Used: ${usedBytes} bytes, Resizing to ${targetMb} MB`);
        await exec.exec("sudo", [
            "btrfs",
            "filesystem",
            "resize",
            `${targetMb}M`,
            this.mountPoint
        ]);

        // Unmount
        await this.unmount();

        // Compress with LZ4
        core.info(`[BTRFS] Compressing image with LZ4 → ${this.archivePath}`);
        await exec.exec("lz4", ["--rm", this.imageFile, this.archivePath]);
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
                `BTRFS-LZ4 compression is only supported on Linux platforms. ` +
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
            { command: "lz4", description: "LZ4 compression (install lz4)" },
            {
                command: "sudo",
                description: "elevated privileges for mounting operations"
            }
        ];

        const missingTools: string[] = [];
        await Promise.all(
            requiredTools.map(async tool => {
                try {
                    await exec.exec("which", [tool.command], { silent: true });
                } catch (error) {
                    missingTools.push(`${tool.command} (${tool.description})`);
                }
            })
        );

        if (missingTools.length > 0) {
            throw new Error(
                `Missing required tools for BTRFS-LZ4 compression: ${missingTools.join(
                    ", "
                )}. ` +
                    `Please install the missing tools or use a different compression method.`
            );
        }

        // Check if sudo works without password prompt (for CI environments)
        try {
            await exec.exec("sudo", ["-n", "true"], { silent: true });
        } catch (error) {
            throw new Error(
                `sudo access is required for BTRFS mounting operations but sudo is not available or requires a password. ` +
                    `Please ensure the runner has passwordless sudo access or use a different compression method.`
            );
        }
    }

    private async getBtrfsUsage(): Promise<string> {
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

    private async mount(): Promise<void> {
        // Create mount point and mount the image
        await fs.mkdir(this.mountPoint, { recursive: true });
        core.info(`[BTRFS] Mounting image to ${this.mountPoint}`);
        await exec.exec("sudo", [
            "mount",
            "-o",
            "loop,rw",
            this.imageFile,
            this.mountPoint
        ]);

        // Bind-mount each path to cache into the BTRFS mount
        const promises = this.pathsToCache.map(async p => {
            const absPath = path.join(this.baseDir, p);
            const targetPath = path.join(this.mountPoint, p);

            core.info(`[BTRFS] Bind-mounting ${absPath} → ${targetPath}`);
            await Promise.all([
                exec.exec("sudo", ["mkdir", "-p", targetPath]),
                fs.mkdir(absPath, { recursive: true })
            ]);
            await exec.exec("sudo", ["mount", "--bind", absPath, targetPath]);
        });
        await Promise.all(promises);
    }

    private async unmount(): Promise<void> {
        try {
            await exec.exec("sync");

            // Check if mounted
            const mountCheck = await exec.exec(
                "mountpoint",
                [this.mountPoint],
                {
                    ignoreReturnCode: true,
                    silent: true
                }
            );

            if (mountCheck === 0) {
                await exec.exec("sudo", ["umount", this.mountPoint]);
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

export function isBtrfsCompressionMethod(compressionMethod?: string): boolean {
    return compressionMethod === "btrfs-lz4";
}
