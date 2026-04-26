import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs/promises";
import * as path from "path";

import { createCacheKeySpecificTempDirectory } from "../actionUtils";
import { Container, ContainerOptions } from "./Container";
import { NodeLocalCache } from "./NodeLocalCache";

const MOUNT_TIMEOUT_MS = 60_000;
const MIN_DISK_HEADROOM_MB = 1024;

/**
 * VhdxContainer implements Windows disk-image caching using VHD/VHDX files.
 *
 * Strategy: create a dynamically-expanding VHDX → format NTFS with compression
 * → mount to a drive letter → junction-link workspace paths to the mounted volume.
 *
 * Uses `diskpart` for VHD creation (available on all Windows Server images) and
 * `Mount-DiskImage` / `Dismount-DiskImage` from the built-in Storage PowerShell
 * module for mount operations (does NOT require Hyper-V).
 */
export class VhdxContainer extends Container {
    public requiresCreateEmptyCache = true;
    public requiresKeepArchive = true;

    private mountDriveLetter: string | undefined;
    private fsSize: string;
    private bufferBytes: number;
    private readonly nodeLocal: NodeLocalCache;
    private restoredFromNodeLocal = false;

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
            compressionLevel ?? "ntfs",
            baseDir,
            pathsToCache,
            cacheKey,
            options
        );

        if (!options.fsSize) {
            throw new Error("fsSize option is required for VhdxContainer");
        }

        this.fsSize = options.fsSize;
        this.bufferBytes = (options.bufferMb ?? 512) * 1024 * 1024;
        this.nodeLocal = new NodeLocalCache(
            options.nodeLocalCacheDir || "",
            cacheKey,
            ".vhdx"
        );

        // Security: validate paths
        this.checkPathTraversal(this.baseDir, this.containerFile);
        this.pathsToCache.forEach(p =>
            this.checkPathTraversal(this.baseDir, p)
        );

        // Validate fsSize format
        if (!/^[0-9]+[KMGT]?$/.test(this.fsSize)) {
            throw new Error(
                `Invalid filesystem size format: ${this.fsSize}. Must be a number followed by optional K, M, G, or T.`
            );
        }
    }

    isSupportedMethod(method?: string): boolean {
        return method === "vhdx";
    }

    async initialize(): Promise<void> {
        try {
            await this.checkPrerequisites();
            await this.nodeLocal.cleanupStaleTempFiles();
        } catch (e) {
            core.setFailed((e as Error).message);
            process.exit(1);
        }
    }

    async tryRestoreFromNodeLocal(restoreKeys?: string[]): Promise<boolean> {
        if (!this.nodeLocal.enabled) return false;

        // 1. Try exact key match
        const localExists = await this.nodeLocal.exists();
        let localPath: string | null = localExists ? this.nodeLocal.localPath : null;

        // 2. Try partial match from restore-keys
        if (!localPath && restoreKeys && restoreKeys.length > 0) {
            localPath = await this.nodeLocal.findClosestMatch(restoreKeys);
            if (localPath) {
                this.logInfo(`Node-local partial hit — using ${localPath}`);
            }
        }

        if (!localPath) return false;

        this.logInfo(`Node-local cache hit — restoring from ${localPath}`);

        try {
            // Copy to job-local location (VHDX mount always needs write access for junction setup)
            const tempDir = await createCacheKeySpecificTempDirectory(this.cacheKey);
            const localCopy = path.join(tempDir, "cache.vhdx");
            await fs.copyFile(localPath, localCopy);
            this.containerFile = localCopy;

            await this.restore();
            this.restoredFromNodeLocal = true;
            return true;
        } catch (error) {
            core.warning(
                `${this.getLogPrefix()} Node-local restore failed, falling back to S3: ${
                    error instanceof Error ? error.message : error
                }`
            );
            return false;
        }
    }

    shouldSkipS3Upload(): boolean {
        return this.restoredFromNodeLocal;
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

    protected getLogPrefix(): string {
        return "[VHDX]";
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private async psExec(script: string): Promise<string> {
        let output = "";
        await exec.exec("powershell", ["-NoProfile", "-Command", script], {
            listeners: {
                stdout: (data: Buffer) => {
                    output += data.toString();
                }
            },
            silent: !core.isDebug()
        });
        return output.trim();
    }

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

    private checkPathTraversal(base: string, pathToCheck: string): void {
        const absBase = path.resolve(base);
        const absPath = path.resolve(path.join(base, pathToCheck));
        if (!absPath.startsWith(absBase)) {
            throw new Error(
                `Path traversal detected: ${pathToCheck} resolves outside base directory`
            );
        }
    }

    private parseSizeToMb(size: string): number {
        const match = size.match(/^(\d+)([KMGT])?$/);
        if (!match) return 0;

        let mb = parseInt(match[1], 10);
        switch (match[2]) {
            case "K":
                mb = Math.ceil(mb / 1024);
                break;
            case "M":
                break;
            case "G":
                mb *= 1024;
                break;
            case "T":
                mb *= 1024 * 1024;
                break;
            default:
                mb = Math.ceil(mb / (1024 * 1024));
                break;
        }
        return mb;
    }

    private async checkDiskSpace(targetPath: string): Promise<number> {
        try {
            const driveLetter = path.parse(targetPath).root || "C:\\";
            const output = await this.psExec(
                `(Get-PSDrive -Name '${driveLetter[0]}').Free`
            );
            const freeBytes = parseInt(output, 10);
            if (!isNaN(freeBytes)) {
                const freeMb = Math.floor(freeBytes / (1024 * 1024));
                this.logDebug(`Available disk space on ${driveLetter}: ${freeMb} MB`);
                if (freeMb < MIN_DISK_HEADROOM_MB) {
                    core.warning(
                        `${this.getLogPrefix()} Low disk space: ${freeMb} MB available ` +
                            `(minimum recommended: ${MIN_DISK_HEADROOM_MB} MB).`
                    );
                }
                return freeBytes;
            }
        } catch {
            this.logDebug("Could not check disk space (non-critical)");
        }
        return 0;
    }

    // ── Prerequisites ───────────────────────────────────────────────

    private async checkPrerequisites(): Promise<void> {
        if (process.platform !== "win32") {
            throw new Error(
                `VHDX compression is only supported on Windows platforms. ` +
                    `Current platform: ${process.platform}. ` +
                    `Use 'btrfs' on Linux runners instead.`
            );
        }

        // Verify diskpart is available
        try {
            await exec.exec("where", ["diskpart"], {
                silent: !core.isDebug()
            });
        } catch {
            throw new Error(
                "diskpart is required but not found. This should be available on all Windows Server runners."
            );
        }

        // Verify Mount-DiskImage cmdlet (Storage module)
        try {
            await this.psExec("Get-Command Mount-DiskImage -ErrorAction Stop | Out-Null");
        } catch {
            throw new Error(
                "Mount-DiskImage cmdlet not found. The Storage PowerShell module is required."
            );
        }
    }

    // ── Create (cache miss) ─────────────────────────────────────────

    async createEmptyCache(): Promise<void> {
        try {
            const sizeMb = this.parseSizeToMb(this.fsSize);
            await this.checkDiskSpace(path.dirname(this.containerFile));

            this.logInfo(
                `Creating dynamic VHDX: ${this.containerFile} (max ${sizeMb} MB)`
            );

            // Use diskpart to create a dynamic VHDX
            const absPath = path.resolve(this.containerFile);
            const scriptContent = [
                `create vdisk file="${absPath}" maximum=${sizeMb} type=expandable`,
                `select vdisk file="${absPath}"`,
                `attach vdisk`,
                `create partition primary`,
                `format fs=ntfs quick compress`,
                `assign`
            ].join("\n");

            const tempDir = await createCacheKeySpecificTempDirectory(
                this.cacheKey
            );
            const scriptPath = path.join(tempDir, "create-vhdx.txt");
            await fs.mkdir(tempDir, { recursive: true });
            await fs.writeFile(scriptPath, scriptContent, "utf-8");

            await exec.exec("diskpart", ["/s", scriptPath], {
                silent: !core.isDebug()
            });

            // Discover which drive letter was assigned
            await this.discoverMountedDrive();

            if (!this.mountDriveLetter) {
                throw new Error(
                    "VHDX created and attached but no drive letter was assigned"
                );
            }

            // Enable NTFS compression on the root of the volume
            await exec.exec("compact", [
                "/c",
                "/s",
                `/i`,
                `${this.mountDriveLetter}:\\`
            ], { silent: !core.isDebug() });

            // Create junction points
            await this.createJunctions();
        } catch (error) {
            await this.safeDetach();
            throw this.wrapError("create empty VHDX cache", error);
        }
    }

    // ── Restore (cache hit) ─────────────────────────────────────────

    async restore(): Promise<void> {
        try {
            // Verify image exists
            try {
                await fs.access(this.containerFile);
            } catch {
                this.logInfo("VHDX image not found — falling back to empty cache");
                return this.createEmptyCache();
            }

            this.logInfo(`Mounting VHDX: ${this.containerFile}`);

            const absPath = path.resolve(this.containerFile);

            await this.execWithTimeout(
                () =>
                    this.psExec(
                        `Mount-DiskImage -ImagePath '${absPath}' -Access ReadWrite -PassThru | Out-Null`
                    ),
                MOUNT_TIMEOUT_MS,
                `mount VHDX ${absPath}`
            );

            await this.discoverMountedDrive();

            if (!this.mountDriveLetter) {
                core.warning(
                    `${this.getLogPrefix()} VHDX mounted but no drive letter found — falling back to empty cache`
                );
                await this.safeDetach();
                return this.createEmptyCache();
            }

            // Run NTFS chkdsk (readonly) to detect corruption
            await this.checkVolumeHealth();

            await this.createJunctions();
        } catch (error) {
            await this.safeDetach();
            throw this.wrapError("restore VHDX cache", error);
        }
    }

    // ── Save ────────────────────────────────────────────────────────

    async save(): Promise<void> {
        if (!this.mountDriveLetter) {
            await this.discoverMountedDrive();
        }
        if (!this.mountDriveLetter) {
            throw this.createError("No mounted drive letter found for save");
        }

        // Remove junction points before dismount
        await this.removeJunctions();

        // Compact the volume to reclaim space
        this.logDebug("Compacting NTFS volume");
        try {
            await exec.exec(
                "compact",
                ["/c", "/s", "/i", `${this.mountDriveLetter}:\\`],
                { silent: !core.isDebug() }
            );
        } catch {
            this.logDebug("Compact failed (non-critical)");
        }

        // Dismount the VHDX (this also detaches)
        const absPath = path.resolve(this.containerFile);
        this.logDebug(`Dismounting VHDX: ${absPath}`);
        await this.psExec(
            `Dismount-DiskImage -ImagePath '${absPath}' | Out-Null`
        );

        this.logDebug(
            `Save completed. Container file ready for upload: ${this.containerFile}`
        );
    }

    // ── Junction management ─────────────────────────────────────────

    private async createJunctions(): Promise<void> {
        if (!this.mountDriveLetter) {
            throw new Error("Drive letter not set");
        }

        for (const p of this.pathsToCache) {
            const absPath = path.join(this.baseDir, p);
            const vhdxPath = path.join(
                `${this.mountDriveLetter}:\\`,
                p
            );

            this.logDebug(`Creating junction: ${absPath} → ${vhdxPath}`);

            // Ensure the target directory exists on the VHDX volume
            await fs.mkdir(vhdxPath, { recursive: true });

            // Remove existing directory/junction at the workspace path
            try {
                const stat = await fs.lstat(absPath);
                if (stat.isSymbolicLink() || stat.isDirectory()) {
                    // For junctions/symlinks, just remove the link
                    await this.psExec(
                        `if (Test-Path '${absPath}') { ` +
                            `$item = Get-Item '${absPath}' -Force; ` +
                            `if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { ` +
                            `  [IO.Directory]::Delete('${absPath}'); ` +
                            `} else { Remove-Item '${absPath}' -Recurse -Force } }`
                    );
                }
            } catch {
                // Path doesn't exist yet — that's fine
            }

            // Create NTFS junction point
            await exec.exec("cmd", ["/c", "mklink", "/J", absPath, vhdxPath], {
                silent: !core.isDebug()
            });
        }
    }

    private async removeJunctions(): Promise<void> {
        for (const p of this.pathsToCache) {
            const absPath = path.join(this.baseDir, p);
            try {
                const stat = await fs.lstat(absPath);
                if (stat.isSymbolicLink() || stat.isDirectory()) {
                    await this.psExec(
                        `$item = Get-Item '${absPath}' -Force; ` +
                            `if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { ` +
                            `  [IO.Directory]::Delete('${absPath}') }`
                    );
                    this.logDebug(`Removed junction: ${absPath}`);
                }
            } catch {
                // Not a junction or doesn't exist
            }
        }
    }

    // ── Drive discovery ─────────────────────────────────────────────

    private async discoverMountedDrive(): Promise<void> {
        const absPath = path.resolve(this.containerFile);

        // Get the drive letter via PowerShell
        const output = await this.psExec(
            `$disk = Get-DiskImage -ImagePath '${absPath}' | Get-Disk; ` +
                `$disk | Get-Partition | Where-Object { $_.DriveLetter } | ` +
                `Select-Object -ExpandProperty DriveLetter -First 1`
        );

        const letter = output.trim();
        if (/^[A-Z]$/i.test(letter)) {
            this.mountDriveLetter = letter.toUpperCase();
            this.logDebug(`Discovered drive letter: ${this.mountDriveLetter}`);
        } else {
            this.logDebug(`Could not discover drive letter. Output: ${output}`);
            this.mountDriveLetter = undefined;
        }
    }

    // ── Health checks ───────────────────────────────────────────────

    private async checkVolumeHealth(): Promise<void> {
        if (!this.mountDriveLetter) return;

        try {
            // Run chkdsk in read-only scan mode
            let output = "";
            await exec.exec(
                "chkdsk",
                [`${this.mountDriveLetter}:`, "/scan"],
                {
                    ignoreReturnCode: true,
                    silent: !core.isDebug(),
                    listeners: {
                        stdout: (data: Buffer) => {
                            output += data.toString();
                        }
                    }
                }
            );

            if (output.includes("found problems")) {
                core.warning(
                    `${this.getLogPrefix()} Volume health check found issues on ${this.mountDriveLetter}:. ` +
                        `Consider recreating the cache.`
                );
            } else {
                this.logDebug("Volume health check: clean");
            }
        } catch {
            this.logDebug("Could not check volume health (non-critical)");
        }
    }

    // ── Cleanup ─────────────────────────────────────────────────────

    private async safeDetach(): Promise<void> {
        try {
            const absPath = path.resolve(this.containerFile);
            await this.psExec(
                `Dismount-DiskImage -ImagePath '${absPath}' -ErrorAction SilentlyContinue | Out-Null`
            );
        } catch {
            // Best-effort cleanup
        }
    }
}
