/**
 * BtrfsImage — pure BTRFS image lifecycle operations.
 *
 * Responsibilities: create sparse image, format, mount/unmount (RO/RW),
 * defrag, resize, truncate, verify, loop device management.
 *
 * Does NOT know about bind mounts, workspace paths, node-local caching,
 * or cache keys. Those concerns belong to BtrfsContainer (the orchestrator).
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MOUNT_TIMEOUT_MS = 30_000;
const MIN_DISK_HEADROOM_MB = 1024;
const LOG_PREFIX = "[BTRFS]";

export interface BtrfsImageOptions {
    compressionLevel: string;
    saveCompressionLevel: string;
    bufferBytes: number;
    safeCwd: string;
}

export class BtrfsImage {
    private activeLoopDevice: string | undefined;

    constructor(
        private imageFile: string,
        private opts: BtrfsImageOptions
    ) {}

    /** Update the backing file path (e.g. after copying for RW). */
    setImageFile(filePath: string): void {
        this.imageFile = filePath;
    }

    getImageFile(): string {
        return this.imageFile;
    }

    /** Set the safe CWD for exec calls (needed after async mkdtemp in initialize). */
    setSafeCwd(cwd: string): void {
        this.opts.safeCwd = cwd;
    }

    // ── Create ──────────────────────────────────────────────────────

    async createSparseImage(fsSize: string): Promise<void> {
        const effectiveSize = await this.calculateSparseSize(
            path.dirname(this.imageFile),
            fsSize
        );
        info(`Creating sparse image: ${this.imageFile} (virtual size: ${effectiveSize})`);
        await exec.exec("truncate", ["-s", effectiveSize, this.imageFile], {
            cwd: this.opts.safeCwd
        });
        info("Formatting image with BTRFS");
        await exec.exec("mkfs.btrfs", ["-f", this.imageFile], {
            cwd: this.opts.safeCwd,
            silent: !core.isDebug()
        });
    }

    // ── Mount / Unmount ─────────────────────────────────────────────

    async mountRO(mountPoint: string): Promise<void> {
        info(`Mounting read-only: ${this.imageFile} → ${mountPoint}`);
        await fs.mkdir(mountPoint, { recursive: true });
        await this.mountWithErrorHandling(this.imageFile, mountPoint, [
            "loop",
            "ro",
            `compress=${this.opts.compressionLevel}`
        ]);
    }

    async mountRW(mountPoint: string): Promise<void> {
        core.debug(`${LOG_PREFIX} Mounting image to ${mountPoint}`);
        await fs.mkdir(mountPoint, { recursive: true });
        await this.mountWithErrorHandling(this.imageFile, mountPoint, [
            "loop",
            "rw",
            `compress=${this.opts.compressionLevel}`
        ]);
    }

    async unmount(mountPoint: string): Promise<void> {
        try {
            await exec.exec("sync", [], {
                cwd: this.opts.safeCwd,
                silent: !core.isDebug()
            });

            const rc = await exec.exec("mountpoint", [mountPoint], {
                cwd: this.opts.safeCwd,
                ignoreReturnCode: true,
                silent: !core.isDebug()
            });
            if (rc === 0) {
                core.debug(`${LOG_PREFIX} Unmounting: ${mountPoint}`);
                await this.umountSafe(mountPoint);
            }

            if (this.activeLoopDevice) {
                core.debug(
                    `${LOG_PREFIX} Detaching loop device: ${this.activeLoopDevice}`
                );
                try {
                    await sudoExec("losetup", ["-d", this.activeLoopDevice], this.opts.safeCwd);
                } catch {
                    core.debug(
                        `Failed to detach loop device ${this.activeLoopDevice}`
                    );
                }
                this.activeLoopDevice = undefined;
            }
        } catch (error) {
            core.debug(`Cleanup mount failed (non-critical): ${error}`);
        }

        try {
            await fs.rm(mountPoint, { recursive: true, force: true });
        } catch (error) {
            core.debug(`Cleanup mount point failed (non-critical): ${error}`);
        }
    }

    async umountSafe(target: string): Promise<void> {
        try {
            await sudoExec("umount", [target], this.opts.safeCwd);
        } catch (error) {
            core.warning(
                `${LOG_PREFIX} Failed to umount ${target}: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    // ── Save pipeline: defrag → resize → unmount → truncate → verify ──

    async prepareSave(mountPoint: string): Promise<void> {
        const defragAlgo = this.opts.saveCompressionLevel.split(":")[0];

        // Remount with save-level compression before defrag
        info(
            `Remounting with compress-force=${this.opts.saveCompressionLevel} before defrag`
        );
        try {
            await exec.exec(
                "sudo",
                [
                    "mount",
                    "-o",
                    `remount,compress-force=${this.opts.saveCompressionLevel}`,
                    mountPoint
                ],
                { cwd: this.opts.safeCwd }
            );
        } catch (e) {
            core.warning(
                `Remount with save compression failed: ${
                    e instanceof Error ? e.message : e
                }`
            );
        }

        // Defrag + recompress
        info(
            `Defragmenting + recompressing with ${defragAlgo} (save-compression-level: ${this.opts.saveCompressionLevel})`
        );
        try {
            await exec.exec(
                "sudo",
                [
                    "btrfs",
                    "filesystem",
                    "defragment",
                    "-r",
                    `-c${defragAlgo}`,
                    mountPoint
                ],
                { cwd: this.opts.safeCwd }
            );
        } catch (e) {
            core.warning(
                `Defrag failed (will upload at mount-time compression): ${
                    e instanceof Error ? e.message : e
                }`
            );
        }

        await exec.exec("sync", [], {
            cwd: this.opts.safeCwd,
            silent: !core.isDebug()
        });

        // Resize filesystem
        let usedBytes = 0;
        let fsResizeSucceeded = false;
        try {
            const usageOutput = await this.getBtrfsUsage(mountPoint);
            usedBytes = this.parseUsedBytes(usageOutput);
        } catch (error) {
            core.warning(
                `Could not determine exact usage, using default buffer: ${error}`
            );
            usedBytes = 512 * 1024 * 1024;
        }

        const targetSize = usedBytes + this.opts.bufferBytes;
        const targetMb = Math.max(
            1,
            Math.ceil(targetSize / (1024 * 1024))
        );

        info(
            `Resize target: ${targetMb} MB (effective usage: ${Math.ceil(usedBytes / (1024 * 1024))} MB + ${Math.ceil(this.opts.bufferBytes / (1024 * 1024))} MB buffer)`
        );
        try {
            await exec.exec(
                "sudo",
                [
                    "btrfs",
                    "filesystem",
                    "resize",
                    `${targetMb}M`,
                    mountPoint
                ],
                { cwd: this.opts.safeCwd, silent: !core.isDebug() }
            );
            fsResizeSucceeded = true;
        } catch (e) {
            core.warning(
                `Filesystem resize failed (will upload at original size): ${
                    e instanceof Error ? e.message : e
                }`
            );
        }

        await exec.exec("sync", [], {
            cwd: this.opts.safeCwd,
            silent: !core.isDebug()
        });

        // Truncate backing file only if resize succeeded
        if (fsResizeSucceeded) {
            core.debug(`${LOG_PREFIX} Resizing backing file to ${targetMb} MB`);
            try {
                await exec.exec(
                    "truncate",
                    ["-s", `${targetMb}M`, this.imageFile],
                    { cwd: this.opts.safeCwd }
                );
            } catch (e) {
                core.warning(
                    `Backing file truncate failed: ${
                        e instanceof Error ? e.message : e
                    }`
                );
            }
        } else {
            info(
                "Skipping backing file truncation — filesystem resize did not succeed"
            );
        }

        await exec.exec("sync", [], {
            cwd: this.opts.safeCwd,
            silent: !core.isDebug()
        });
    }

    /**
     * Verify the image is mountable by doing a RO losetup+mount+umount cycle.
     * Returns false if verification fails (caller should abort S3 upload).
     */
    async verifyMountable(): Promise<boolean> {
        info("Verifying image is mountable before upload...");
        const verifyDir = `${this.imageFile}.verify-mount`;
        try {
            const loopDev = await this.setupLoopDevice(this.imageFile);
            try {
                await exec.exec("mkdir", ["-p", verifyDir], {
                    cwd: this.opts.safeCwd
                });
                await exec.exec(
                    "sudo",
                    ["mount", "-t", "btrfs", "-o", "ro", loopDev, verifyDir],
                    { cwd: this.opts.safeCwd }
                );
                await exec.exec("sudo", ["umount", verifyDir], {
                    cwd: this.opts.safeCwd
                });
                info("Verification mount succeeded — image is safe to upload");
                return true;
            } finally {
                await this.cleanupLoopDevices(this.imageFile);
                await exec
                    .exec("rm", ["-rf", verifyDir], {
                        cwd: this.opts.safeCwd
                    })
                    .catch(() => {});
            }
        } catch (verifyError) {
            core.error(
                `Verification mount FAILED — aborting S3 upload to prevent poisoning cache: ${
                    verifyError instanceof Error
                        ? verifyError.message
                        : verifyError
                }`
            );
            return false;
        }
    }

    // ── UUID randomization (K8s HostPath dedup) ─────────────────────

    async randomizeUuid(): Promise<void> {
        info("Randomizing BTRFS UUID on copy");
        await sudoExec("btrfstune", ["-f", "-u", this.imageFile], this.opts.safeCwd);
    }

    // ── Filesystem health ───────────────────────────────────────────

    async checkHealth(mountPoint: string): Promise<void> {
        try {
            const output = await execWithOutput("sudo", [
                "btrfs",
                "device",
                "stats",
                mountPoint
            ], this.opts.safeCwd);

            const errorLines = output
                .split("\n")
                .filter(line => {
                    const match = line.match(/\.(\w+_errs)\s+(\d+)/);
                    return match && parseInt(match[2], 10) > 0;
                });

            if (errorLines.length > 0) {
                core.warning(
                    `${LOG_PREFIX} Filesystem has I/O errors:\n${errorLines.join("\n")}` +
                        `\nConsider recreating the cache image.`
                );
            } else {
                core.debug(`${LOG_PREFIX} Filesystem health check: no errors detected`);
            }
        } catch {
            core.debug(
                `${LOG_PREFIX} Could not check filesystem health (non-critical)`
            );
        }
    }

    // ── Loop device management ──────────────────────────────────────

    async cleanupLoopDevices(imageFile: string): Promise<void> {
        try {
            const output = await execWithOutput("losetup", ["-j", imageFile], this.opts.safeCwd);
            if (!output) return;

            const devices = output
                .split("\n")
                .map(line => line.split(":")[0])
                .filter(d => d.startsWith("/dev/loop"));

            for (const device of devices) {
                core.debug(`${LOG_PREFIX} Cleaning up leaked loop device: ${device}`);
                try {
                    await sudoExec("losetup", ["-d", device], this.opts.safeCwd);
                } catch {
                    core.warning(
                        `${LOG_PREFIX} Failed to detach loop device ${device}`
                    );
                }
            }
        } catch {
            // losetup -j may fail if no loop devices exist
        }
    }

    // ── Prerequisites ───────────────────────────────────────────────

    async checkPrerequisites(): Promise<void> {
        if (process.platform !== "linux") {
            throw new Error(
                `BTRFS compression is only supported on Linux. Current platform: ${process.platform}.`
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
                command: "losetup",
                description: "loop device management (install util-linux)"
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
                        cwd: this.opts.safeCwd,
                        silent: !core.isDebug()
                    });
                } catch {
                    missingTools.push(`${tool.command} (${tool.description})`);
                }
            })
        );

        if (missingTools.length > 0) {
            throw new Error(
                `Missing required tools for BTRFS compression: ${missingTools.join(", ")}.`
            );
        }

        // Passwordless sudo check
        try {
            await exec.exec("sudo", ["-n", "true"], {
                cwd: this.opts.safeCwd,
                silent: !core.isDebug()
            });
        } catch {
            throw new Error(
                "sudo access is required for BTRFS mounting but sudo is not available or requires a password."
            );
        }

        // Ensure kernel modules are loaded (K8s nodes may not auto-load)
        for (const mod of ["loop", "btrfs"]) {
            try {
                await exec.exec("sudo", ["modprobe", mod], {
                    cwd: this.opts.safeCwd,
                    silent: !core.isDebug()
                });
            } catch (error) {
                core.debug(
                    `${LOG_PREFIX} modprobe ${mod} failed (module likely built-in): ${
                        error instanceof Error ? error.message : error
                    }`
                );
            }
        }
    }

    // ── Private helpers ─────────────────────────────────────────────

    private async setupLoopDevice(imageFile: string): Promise<string> {
        let loopDev = "";
        let stderrOutput = "";
        try {
            await exec.exec(
                "sudo",
                ["losetup", "--find", "--show", imageFile],
                {
                    cwd: this.opts.safeCwd,
                    listeners: {
                        stdout: (data: Buffer) => {
                            loopDev += data.toString();
                        },
                        stderr: (data: Buffer) => {
                            stderrOutput += data.toString();
                        }
                    },
                    silent: !core.isDebug()
                }
            );
        } catch (error) {
            const details = stderrOutput.trim()
                ? `stderr: ${stderrOutput.trim()}`
                : `${error instanceof Error ? error.message : error}`;
            throw new Error(
                `Failed to attach ${imageFile} to a loop device. ` +
                    `Ensure the 'loop' kernel module is loaded. ` +
                    `${details}`
            );
        }
        loopDev = loopDev.trim();
        if (!loopDev.startsWith("/dev/loop")) {
            throw new Error(
                `losetup returned unexpected output: "${loopDev}".`
            );
        }
        info(`Attached ${imageFile} → ${loopDev}`);
        return loopDev;
    }

    private async mountWithErrorHandling(
        device: string,
        mountPath: string,
        options?: string[]
    ): Promise<void> {
        const isLoopMount = options?.includes("loop");
        const filteredOptions = options?.filter(o => o !== "loop") || [];
        let actualDevice = device;

        try {
            if (isLoopMount) {
                const loopDev = await this.setupLoopDevice(device);
                actualDevice = loopDev;
                this.activeLoopDevice = loopDev;
            }

            const mountArgs = [actualDevice, mountPath];
            if (filteredOptions.length > 0) {
                mountArgs.unshift("-o", filteredOptions.join(","));
            }
            if (isLoopMount) {
                mountArgs.unshift("-t", "btrfs");
            }

            await execWithTimeout(
                () =>
                    exec.exec("sudo", ["mount", ...mountArgs], {
                        cwd: this.opts.safeCwd,
                        silent: !core.isDebug()
                    }),
                MOUNT_TIMEOUT_MS,
                `mount ${actualDevice} at ${mountPath}`
            );
        } catch (error) {
            // Diagnostics: only collect in debug mode to keep normal failures fast
            if (core.isDebug()) {
                await this.collectMountDiagnostics(device, actualDevice);
            }

            await this.cleanupLoopDevices(device);
            this.activeLoopDevice = undefined;
            throw new Error(
                `Failed to mount ${actualDevice} at ${mountPath}: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    /**
     * Collect diagnostic info on mount failure (debug-only).
     * Runs stat, losetup, dmesg, btrfs check, dump-super.
     */
    private async collectMountDiagnostics(
        imageFile: string,
        actualDevice: string
    ): Promise<void> {
        try {
            const diag: string[] = [];
            const collect = async (
                label: string,
                cmd: string,
                cmdArgs: string[]
            ) => {
                try {
                    let out = "";
                    await exec.exec(cmd, cmdArgs, {
                        cwd: this.opts.safeCwd,
                        silent: true,
                        listeners: {
                            stdout: (d: Buffer) => {
                                out += d.toString();
                            }
                        }
                    });
                    diag.push(`${label}: ${out.trim()}`);
                } catch {
                    diag.push(`${label}: <unavailable>`);
                }
            };
            await collect("file size", "stat", [
                "--format=%s",
                imageFile
            ]);
            await collect("loop devices", "sudo", ["losetup", "-a"]);
            await collect("dmesg (last 40 lines)", "bash", [
                "-c",
                "sudo dmesg -T 2>/dev/null | tail -40 || sudo dmesg 2>/dev/null | tail -40 || echo unavailable"
            ]);
            if (actualDevice.startsWith("/dev/loop")) {
                await exec
                    .exec(
                        "bash",
                        [
                            "-c",
                            "command -v btrfs >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq btrfs-progs 2>/dev/null) || true"
                        ],
                        { cwd: this.opts.safeCwd, silent: true }
                    )
                    .catch(() => {});
                await collect("btrfs check --readonly", "sudo", [
                    "btrfs",
                    "check",
                    "--readonly",
                    actualDevice
                ]);
                await collect(
                    "btrfs superblock (compat flags)",
                    "bash",
                    [
                        "-c",
                        `sudo btrfs inspect-internal dump-super ${actualDevice} 2>&1 | grep -iE 'compat|magic|generation|sectorsize|nodesize|root_level'`
                    ]
                );
            }
            for (const d of diag) {
                core.warning(`${LOG_PREFIX} ${d}`);
            }
        } catch {
            /* diagnostic collection is best-effort */
        }
    }

    private async getBtrfsUsage(mountPoint: string): Promise<string> {
        return execWithOutput("sudo", [
            "btrfs",
            "filesystem",
            "usage",
            "-b",
            mountPoint
        ], this.opts.safeCwd);
    }

    private parseUsedBytes(usageOutput: string): number {
        const lines = usageOutput.split("\n");
        let used = 0;
        let deviceAllocated = 0;
        for (const line of lines) {
            const usedMatch = line.match(/^\s*Used:\s*(\d+)$/);
            if (usedMatch) {
                used = parseInt(usedMatch[1], 10);
            }
            const allocMatch = line.match(/^\s*Device allocated:\s*(\d+)$/);
            if (allocMatch) {
                deviceAllocated = parseInt(allocMatch[1], 10);
            }
        }
        if (used === 0 && deviceAllocated === 0) {
            throw new Error("Could not parse BTRFS usage output");
        }
        const effective = Math.max(used, deviceAllocated);
        core.debug(
            `${LOG_PREFIX} BTRFS usage — Used: ${used} bytes, Device allocated: ${deviceAllocated} bytes, effective: ${effective} bytes`
        );
        return effective;
    }

    private async calculateSparseSize(
        targetDir: string,
        fsSize: string
    ): Promise<string> {
        const availBytes = await checkDiskSpace(targetDir, this.opts.safeCwd);

        if (availBytes === 0) return fsSize;

        const configuredBytes = parseSizeToBytes(fsSize);
        const safeMaxBytes = Math.floor(availBytes * 0.8);

        if (configuredBytes > safeMaxBytes && safeMaxBytes > 0) {
            const safeSizeGb = Math.max(
                1,
                Math.floor(safeMaxBytes / (1024 * 1024 * 1024))
            );
            info(
                `Reducing sparse file size from ${fsSize} to ${safeSizeGb}G ` +
                    `(80% of ${Math.floor(availBytes / (1024 * 1024 * 1024))}G available)`
            );
            return `${safeSizeGb}G`;
        }

        return fsSize;
    }
}

// ── Module-level helpers (shared, no class dependency) ──────────────

function info(message: string): void {
    core.info(`${LOG_PREFIX} ${message}`);
}

async function sudoExec(
    command: string,
    args: string[],
    cwd: string
): Promise<void> {
    await exec.exec("sudo", [command, ...args], {
        cwd,
        silent: !core.isDebug()
    });
}

async function execWithOutput(
    command: string,
    args: string[],
    cwd: string
): Promise<string> {
    let output = "";
    await exec.exec(command, args, {
        cwd,
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        },
        silent: !core.isDebug()
    });
    return output.trim();
}

async function execWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    description: string
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `${LOG_PREFIX} Operation timed out after ${timeoutMs}ms: ${description}`
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

async function checkDiskSpace(targetPath: string, cwd: string): Promise<number> {
    try {
        const output = await execWithOutput("df", [
            "--output=avail",
            "-B1",
            targetPath
        ], cwd);
        const lines = output.split("\n");
        const availStr = lines[lines.length - 1]?.trim();
        if (availStr) {
            const availBytes = parseInt(availStr, 10);
            const availMb = Math.floor(availBytes / (1024 * 1024));
            core.debug(`${LOG_PREFIX} Available disk space: ${availMb} MB`);

            if (availMb < MIN_DISK_HEADROOM_MB) {
                core.warning(
                    `${LOG_PREFIX} Low disk space: ${availMb} MB available ` +
                        `(minimum recommended: ${MIN_DISK_HEADROOM_MB} MB).`
                );
            }
            return availBytes;
        }
    } catch {
        core.debug(`${LOG_PREFIX} Could not check disk space (non-critical)`);
    }
    return 0;
}

export function parseSizeToBytes(size: string): number {
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

export function validateFsSize(fsSize: string): void {
    if (!/^[0-9]+[KMGT]?$/.test(fsSize)) {
        throw new Error(
            `Invalid filesystem size format: ${fsSize}. Must be a number followed by optional K, M, G, or T.`
        );
    }
}

export function validateCompressionLevel(level: string): void {
    const regex =
        /^(zlib(?:[:][1-9])?|lzo|zstd(?::-?(?:[0-9]|1[0-5]))?)$/;
    if (!regex.test(level)) {
        throw new Error(
            `Invalid compression level format: ${level}.`
        );
    }
}
