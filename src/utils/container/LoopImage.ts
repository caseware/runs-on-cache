/**
 * LoopImage — fs-agnostic loop-device image lifecycle.
 *
 * Holds ALL filesystem-independent logic shared by BtrfsImage and XfsImage:
 * sparse image creation, loop-device attach/detach (with retry), generic
 * mount/unmount/umountSafe, RW headroom expansion (disk-budget math), mount
 * diagnostics, loop-device cleanup, prerequisite scaffolding, and disk-space
 * helpers.
 *
 * Subclasses provide ONLY the genuinely fs-specific pieces via the protected
 * abstract hooks below (mkfs command, mount fs-type + options, grow command,
 * UUID-randomization command, save-time shrink behaviour, verify, health, and
 * the fs-specific required tools / kernel modules).
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MOUNT_TIMEOUT_MS = 30_000;
const MIN_DISK_HEADROOM_MB = 1024;

export interface LoopImageOptions {
    /** Target utilization on RESTORE RW — dynamic headroom (default 0.80). */
    rwUtilizationTarget: number;
    safeCwd: string;
}

export interface RequiredTool {
    command: string;
    description: string;
}

export abstract class LoopImage {
    private activeLoopDevice: string | undefined;

    constructor(
        protected imageFile: string,
        protected baseOpts: LoopImageOptions
    ) {}

    // ── fs-specific hooks (implemented by subclasses) ─────────────────

    /** Log prefix, e.g. "[BTRFS]" / "[XFS]". */
    protected abstract get logPrefix(): string;
    /** mkfs command + args (image file appended by caller). e.g. ["mkfs.btrfs", "-f"]. */
    protected abstract mkfsCommand(): string[];
    /** Filesystem type passed to `mount -t`, e.g. "btrfs" | "xfs". */
    protected abstract mountFsType(): string;
    /** Mount options for the given mode (NOT including "loop"); e.g. btrfs adds compress=. */
    protected abstract mountOptions(mode: "ro" | "rw"): string[];
    /** Grow the mounted filesystem to fill its (already-expanded) backing device. */
    protected abstract growFilesystem(mountPoint: string): Promise<void>;
    /** Randomize the on-disk UUID of the (unmounted) image. */
    abstract randomizeUuid(): Promise<void>;
    /** fs-specific tools required by checkPrerequisites (beyond the shared set). */
    protected abstract fsRequiredTools(): RequiredTool[];
    /** Kernel modules to modprobe (loop is always included by the base). */
    protected abstract fsKernelModules(): string[];
    /** Human-readable fs name for prerequisite/error messages, e.g. "BTRFS". */
    protected abstract get fsDisplayName(): string;

    // ── shared lifecycle ──────────────────────────────────────────────

    /** Update the backing file path (e.g. after copying for RW). */
    setImageFile(filePath: string): void {
        this.imageFile = filePath;
    }

    getImageFile(): string {
        return this.imageFile;
    }

    /** Set the safe CWD for exec calls (needed after async mkdtemp in initialize). */
    setSafeCwd(cwd: string): void {
        this.baseOpts.safeCwd = cwd;
    }

    protected get safeCwd(): string {
        return this.baseOpts.safeCwd;
    }

    protected info(message: string): void {
        core.info(`${this.logPrefix} ${message}`);
    }

    // ── Create ──────────────────────────────────────────────────────

    async createSparseImage(fsSize: string): Promise<void> {
        const effectiveSize = await this.calculateSparseSize(
            path.dirname(this.imageFile),
            fsSize
        );
        this.info(
            `Creating sparse image: ${this.imageFile} (virtual size: ${effectiveSize})`
        );
        await exec.exec("truncate", ["-s", effectiveSize, this.imageFile], {
            cwd: this.safeCwd
        });
        this.info(`Formatting image with ${this.fsDisplayName}`);
        await exec.exec(
            this.mkfsCommand()[0],
            [...this.mkfsCommand().slice(1), this.imageFile],
            { cwd: this.safeCwd, silent: !core.isDebug() }
        );
    }

    // ── Mount / Unmount ─────────────────────────────────────────────

    async mountRO(mountPoint: string): Promise<void> {
        this.info(`Mounting read-only: ${this.imageFile} → ${mountPoint}`);
        await fs.mkdir(mountPoint, { recursive: true });
        await this.mountWithErrorHandling(this.imageFile, mountPoint, [
            "loop",
            "ro",
            ...this.mountOptions("ro")
        ]);
    }

    async mountRW(mountPoint: string): Promise<void> {
        core.debug(`${this.logPrefix} Mounting image to ${mountPoint}`);
        await fs.mkdir(mountPoint, { recursive: true });
        await this.mountWithErrorHandling(this.imageFile, mountPoint, [
            "loop",
            "rw",
            ...this.mountOptions("rw")
        ]);
    }

    /**
     * Expand a mounted RW image to fill up to rwUtilizationTarget of the
     * runner's available disk space.  Called after mountRW on restore — the
     * saved image is tight and the consumer needs room for checkout deltas,
     * build artifacts, etc.
     *
     * Strategy: the image file currently consumes `currentSize` bytes on the
     * host.  The host also has `availOnHost` bytes free (not counting the
     * image).  The total space budget is `currentSize + availOnHost`.
     * We expand to `budget * target` (default 80%), leaving the remaining
     * 20% for non-cache host needs (logs, temp files, other jobs).
     */
    async expandForHeadroom(mountPoint: string): Promise<void> {
        const target = this.baseOpts.rwUtilizationTarget;
        if (target <= 0 || target >= 1) return; // disabled or invalid

        const stat = await fs.stat(this.imageFile);
        // NOTE: stat.size is the SPARSE/apparent size (e.g. 25 GiB virtual), not
        // the physical bytes the image occupies on disk. We must size growth
        // against real free space, never the apparent size, or we overcommit.
        const currentSize = stat.size;
        // Physical bytes actually consumed by the (sparse) image file — this is
        // what counts against host free space. blocks are 512-byte units.
        const currentPhysical = (stat.blocks ?? 0) * 512;

        // Available disk on the host partition where the image file lives
        const imageDir = path.dirname(this.imageFile);
        const availOnHost = await checkDiskSpace(
            imageDir,
            this.safeCwd,
            this.logPrefix
        );

        // Real space budget = what the image already physically uses + free
        // space on the host (NOT the sparse apparent size, which would
        // double-count and overcommit). Reserve a safety margin so growth
        // never consumes the last sliver of the disk — truncating the backing
        // file and then writing into the grown filesystem past actual free
        // space surfaces as EIO (seen on EC2 VM runners where the image and
        // workspace share one disk: expand to 92 GB on 89.5 GB free → EIO on
        // checkout's unlink/rmdir).
        const SAFETY = 0.85; // leave 15% of free space unclaimed
        const usableFree = Math.floor(availOnHost * SAFETY);
        const physicalBudget = currentPhysical + usableFree;
        // Target a share of the budget, but HARD-CAP so the backing file never
        // grows by more than the usable free space allows.
        const desiredSize = Math.min(
            Math.floor((currentPhysical + availOnHost) * target),
            physicalBudget
        );

        const toMb = (b: number) => Math.ceil(b / (1024 * 1024));
        if (desiredSize <= currentSize) {
            this.info(
                `RW headroom: image apparent ${toMb(currentSize)} MB ` +
                    `(physical ${toMb(currentPhysical)} MB), usable free ` +
                    `${toMb(usableFree)} MB — no safe expansion possible`
            );
            return;
        }

        this.info(
            `Expanding for RW headroom: ${toMb(currentSize)} MB → ${toMb(
                desiredSize
            )} MB ` +
                `(physical ${toMb(currentPhysical)} MB, ${toMb(
                    availOnHost
                )} MB free on host, capped at physical+${Math.round(
                    SAFETY * 100
                )}% free = ${toMb(physicalBudget)} MB)`
        );

        // Expand the backing file first (so the filesystem has backing space)
        const desiredMb = toMb(desiredSize);
        try {
            await exec.exec(
                "truncate",
                ["-s", `${desiredMb}M`, this.imageFile],
                { cwd: this.safeCwd }
            );
        } catch (e) {
            core.warning(
                `${this.logPrefix} Backing file expansion failed: ${
                    e instanceof Error ? e.message : e
                }`
            );
            return;
        }

        // CRITICAL: truncating the backing file does NOT tell the already-
        // attached loop device about the new size — it still exposes the old
        // capacity. Growing the filesystem onto that stale, smaller block
        // device leaves the fs believing it has space the loop device won't
        // back, which surfaces as EIO on later writes/rmdir (see the gh-runner
        // warm-restore failure: checkout's clean hit
        // "EIO: i/o error, rmdir .cypress/.../ansi-styles"). Refresh the loop
        // device capacity with `losetup -c` BEFORE growing the filesystem.
        const loopDev = await this.findLoopDeviceFor(this.imageFile);
        if (!loopDev) {
            core.warning(
                `${this.logPrefix} Could not resolve loop device for ${this.imageFile} — skipping filesystem grow to avoid an inconsistent (EIO-prone) mount`
            );
            return;
        }
        try {
            await sudoExec("losetup", ["-c", loopDev], this.safeCwd);
            this.info(
                `Refreshed loop device capacity (${loopDev}) after backing-file grow`
            );
        } catch (e) {
            core.warning(
                `${this.logPrefix} losetup -c (capacity refresh) failed for ${loopDev}: ${
                    e instanceof Error ? e.message : e
                } — skipping filesystem grow to avoid an inconsistent (EIO-prone) mount`
            );
            return;
        }

        // Grow the filesystem to fill the new (now loop-visible) backing space.
        try {
            await this.growFilesystem(mountPoint);
        } catch (e) {
            core.warning(
                `${this.logPrefix} Filesystem grow failed: ${
                    e instanceof Error ? e.message : e
                }`
            );
        }
    }

    /**
     * Resolve the loop device currently backing the given image file via
     * `losetup -j`. Returns the /dev/loopN path or null if none is attached.
     */
    protected async findLoopDeviceFor(
        imageFile: string
    ): Promise<string | null> {
        try {
            const out = await exec.getExecOutput(
                "sudo",
                ["losetup", "-j", imageFile],
                {
                    cwd: this.safeCwd,
                    silent: !core.isDebug(),
                    ignoreReturnCode: true
                }
            );
            // Format: "/dev/loop1: 0 (/tmp/xfs-XXX/cache.xfs)"
            const match = out.stdout.match(/^(\/dev\/loop\d+):/m);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    async unmount(mountPoint: string): Promise<void> {
        try {
            await exec.exec("sync", [], {
                cwd: this.safeCwd,
                silent: !core.isDebug()
            });

            const rc = await exec.exec("mountpoint", [mountPoint], {
                cwd: this.safeCwd,
                ignoreReturnCode: true,
                silent: !core.isDebug()
            });
            if (rc === 0) {
                core.debug(`${this.logPrefix} Unmounting: ${mountPoint}`);
                await this.umountSafe(mountPoint);
            }

            if (this.activeLoopDevice) {
                core.debug(
                    `${this.logPrefix} Detaching loop device: ${this.activeLoopDevice}`
                );
                await this.detachLoopWithRetry(this.activeLoopDevice);
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

    /**
     * Freeze the mounted filesystem at `mountPoint` so its backing file is
     * crash-consistent while it stays mounted (used by the skip-unmount save).
     *
     * Default: the generic `fsfreeze -f` binary, which works on xfs, btrfs and
     * any other fs implementing freeze. If freeze is unsupported / fails we do
     * NOT abort — we WARN and fall back to a plain `sync` (still better than
     * nothing) and leave the fs mounted. Subclasses may override.
     */
    async freeze(mountPoint: string): Promise<void> {
        try {
            await sudoExec("fsfreeze", ["-f", mountPoint], this.safeCwd);
            this.info(`Froze filesystem at ${mountPoint}`);
        } catch (error) {
            core.warning(
                `${this.logPrefix} fsfreeze -f failed for ${mountPoint} (${
                    error instanceof Error ? error.message : error
                }) — falling back to sync (image may be only sync-consistent, not frozen)`
            );
            try {
                await exec.exec("sync", [], {
                    cwd: this.safeCwd,
                    silent: !core.isDebug()
                });
            } catch {
                /* best-effort */
            }
        }
    }

    /**
     * Unfreeze a previously frozen filesystem. Best-effort: ignore errors (a
     * fall-back-to-sync freeze never actually froze, so unfreeze will error —
     * that's fine). MUST be called in a finally so the fs is never left frozen.
     */
    async unfreeze(mountPoint: string): Promise<void> {
        try {
            await sudoExec("fsfreeze", ["-u", mountPoint], this.safeCwd);
            this.info(`Unfroze filesystem at ${mountPoint}`);
        } catch (error) {
            core.debug(
                `${this.logPrefix} fsfreeze -u for ${mountPoint} failed (ignored): ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    async umountSafe(target: string): Promise<void> {
        try {
            await sudoExec("umount", [target], this.safeCwd);
        } catch (error) {
            core.warning(
                `${this.logPrefix} Failed to umount ${target}: ${
                    error instanceof Error ? error.message : error
                }`
            );
            // Lazy unmount as fallback — detaches mount point even if busy.
            // Required when the workspace dir is still a CWD of running procs.
            try {
                await sudoExec("umount", ["-l", target], this.safeCwd);
                core.info(`${this.logPrefix} Lazy-unmounted ${target}`);
            } catch (lazyErr) {
                core.warning(
                    `${this.logPrefix} Lazy umount also failed for ${target}: ${
                        lazyErr instanceof Error ? lazyErr.message : lazyErr
                    }`
                );
            }
        }
    }

    // ── Save pipeline ───────────────────────────────────────────────

    /** fs-specific save preparation (btrfs: defrag+resize+truncate; xfs: sync). */
    abstract prepareSave(mountPoint: string): Promise<void>;

    /** fs-specific pre-upload integrity check. */
    abstract verifyMountable(): Promise<boolean>;

    /** fs-specific online health check (no-op where unsupported). */
    abstract checkHealth(mountPoint: string): Promise<void>;

    // ── Loop device management ──────────────────────────────────────

    async cleanupLoopDevices(imageFile: string): Promise<void> {
        try {
            const output = await execWithOutput(
                "losetup",
                ["-j", imageFile],
                this.safeCwd
            );
            if (!output) return;

            const devices = output
                .split("\n")
                .map(line => line.split(":")[0])
                .filter(d => d.startsWith("/dev/loop"));

            for (const device of devices) {
                core.debug(
                    `${this.logPrefix} Cleaning up leaked loop device: ${device}`
                );
                await this.detachLoopWithRetry(device);
            }
        } catch {
            // losetup -j may fail if no loop devices exist
        }
    }

    /**
     * Detach a loop device with retry logic.
     * After lazy unmount, the kernel may keep the device busy briefly while
     * the filesystem finishes releasing its references. Retries with delay
     * handle this.
     */
    private async detachLoopWithRetry(
        device: string,
        maxRetries = 5
    ): Promise<void> {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await sudoExec("losetup", ["-d", device], this.safeCwd);
                core.debug(
                    `${this.logPrefix} Detached ${device} (attempt ${i + 1})`
                );
                return;
            } catch {
                if (i < maxRetries - 1) {
                    core.debug(
                        `${this.logPrefix} ${device} still busy, retrying in ${
                            i + 1
                        }s...`
                    );
                    await new Promise(resolve =>
                        setTimeout(resolve, (i + 1) * 1000)
                    );
                }
            }
        }
        core.warning(
            `${this.logPrefix} Could not detach loop device ${device} after ${maxRetries} retries`
        );
    }

    // ── Prerequisites ───────────────────────────────────────────────

    async checkPrerequisites(): Promise<void> {
        if (process.platform !== "linux") {
            throw new Error(
                `${this.fsDisplayName} compression is only supported on Linux. Current platform: ${process.platform}.`
            );
        }

        const requiredTools: RequiredTool[] = [
            { command: "truncate", description: "creating sparse files" },
            ...this.fsRequiredTools(),
            {
                command: "losetup",
                description: "loop device management (install util-linux)"
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
                        cwd: this.safeCwd,
                        silent: !core.isDebug()
                    });
                } catch {
                    missingTools.push(`${tool.command} (${tool.description})`);
                }
            })
        );

        if (missingTools.length > 0) {
            throw new Error(
                `Missing required tools for ${
                    this.fsDisplayName
                } compression: ${missingTools.join(", ")}.`
            );
        }

        // Passwordless sudo check
        try {
            await exec.exec("sudo", ["-n", "true"], {
                cwd: this.safeCwd,
                silent: !core.isDebug()
            });
        } catch {
            throw new Error(
                `sudo access is required for ${this.fsDisplayName} mounting but sudo is not available or requires a password.`
            );
        }

        // Ensure kernel modules are loaded (K8s nodes may not auto-load)
        for (const mod of ["loop", ...this.fsKernelModules()]) {
            try {
                await exec.exec("sudo", ["modprobe", mod], {
                    cwd: this.safeCwd,
                    silent: !core.isDebug()
                });
            } catch (error) {
                core.debug(
                    `${
                        this.logPrefix
                    } modprobe ${mod} failed (module likely built-in): ${
                        error instanceof Error ? error.message : error
                    }`
                );
            }
        }

        // Verify loop devices actually work on this runner.
        // K8s pods may lack /dev/loop-control even after modprobe.
        try {
            await exec.exec("sudo", ["losetup", "--find"], {
                cwd: this.safeCwd,
                silent: !core.isDebug()
            });
        } catch (error) {
            core.warning(
                `${this.logPrefix} Loop devices are not available on this runner ` +
                    `(losetup --find failed). ${this.fsDisplayName} caching will not work — ` +
                    `all caches will fall back to S3 download. ` +
                    `Ensure the 'loop' kernel module is loaded and ` +
                    `/dev/loop-control is accessible. ` +
                    `${error instanceof Error ? error.message : error}`
            );
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
                    cwd: this.safeCwd,
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
        this.info(`Attached ${imageFile} → ${loopDev}`);
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
                mountArgs.unshift("-t", this.mountFsType());
            }

            await execWithTimeout(
                () =>
                    exec.exec("sudo", ["mount", ...mountArgs], {
                        cwd: this.safeCwd,
                        silent: !core.isDebug()
                    }),
                MOUNT_TIMEOUT_MS,
                `mount ${actualDevice} at ${mountPath}`,
                this.logPrefix
            );
        } catch (error) {
            // Diagnostics: only collect in debug mode to keep normal failures fast
            if (core.isDebug()) {
                await this.collectMountDiagnostics(device, actualDevice);
            }

            // Detach the loop device directly if we know it, then fall back to
            // file-based lookup. This avoids orphaned loop devices when the image
            // path used for losetup -j doesn't match (symlinks, node-local paths).
            if (this.activeLoopDevice) {
                try {
                    await sudoExec(
                        "losetup",
                        ["-d", this.activeLoopDevice],
                        this.safeCwd
                    );
                    core.debug(
                        `${this.logPrefix} Detached ${this.activeLoopDevice} after mount failure`
                    );
                } catch {
                    core.debug(
                        `${this.logPrefix} Direct detach of ${this.activeLoopDevice} failed, trying file-based cleanup`
                    );
                    await this.cleanupLoopDevices(device);
                }
            } else {
                await this.cleanupLoopDevices(device);
            }
            this.activeLoopDevice = undefined;
            throw new Error(
                `Failed to mount ${actualDevice} at ${mountPath}: ${
                    error instanceof Error ? error.message : error
                }`
            );
        }
    }

    /**
     * Collect generic diagnostic info on mount failure (debug-only): file
     * size, loop devices, dmesg. Subclasses add fs-specific probes via
     * collectFsMountDiagnostics().
     */
    private async collectMountDiagnostics(
        imageFile: string,
        actualDevice: string
    ): Promise<void> {
        try {
            const diag: string[] = [];
            const collect = (label: string, cmd: string, cmdArgs: string[]) =>
                this.collectDiag(diag, label, cmd, cmdArgs);
            await collect("file size", "stat", ["--format=%s", imageFile]);
            await collect("loop devices", "sudo", ["losetup", "-a"]);
            await collect("dmesg (last 40 lines)", "bash", [
                "-c",
                "sudo dmesg -T 2>/dev/null | tail -40 || sudo dmesg 2>/dev/null | tail -40 || echo unavailable"
            ]);
            if (actualDevice.startsWith("/dev/loop")) {
                await this.collectFsMountDiagnostics(actualDevice, collect);
            }
            for (const d of diag) {
                core.warning(`${this.logPrefix} ${d}`);
            }
        } catch {
            /* diagnostic collection is best-effort */
        }
    }

    /** Push one labelled command's output into the diag buffer (best-effort). */
    protected async collectDiag(
        diag: string[],
        label: string,
        cmd: string,
        cmdArgs: string[]
    ): Promise<void> {
        try {
            let out = "";
            await exec.exec(cmd, cmdArgs, {
                cwd: this.safeCwd,
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
    }

    /**
     * fs-specific block-device diagnostics (debug-only). Called only when the
     * mount target is a /dev/loop* device. Default: nothing.
     */
    protected async collectFsMountDiagnostics(
        _actualDevice: string,
        _collect: (
            label: string,
            cmd: string,
            cmdArgs: string[]
        ) => Promise<void>
    ): Promise<void> {
        /* default: no fs-specific probes */
    }

    private async calculateSparseSize(
        targetDir: string,
        fsSize: string
    ): Promise<string> {
        const availBytes = await checkDiskSpace(
            targetDir,
            this.safeCwd,
            this.logPrefix
        );

        if (availBytes === 0) return fsSize;

        const configuredBytes = parseSizeToBytes(fsSize);
        const safeMaxBytes = Math.floor(availBytes * 0.8);

        if (configuredBytes > safeMaxBytes && safeMaxBytes > 0) {
            const safeSizeGb = Math.max(
                1,
                Math.floor(safeMaxBytes / (1024 * 1024 * 1024))
            );
            this.info(
                `Reducing sparse file size from ${fsSize} to ${safeSizeGb}G ` +
                    `(80% of ${Math.floor(
                        availBytes / (1024 * 1024 * 1024)
                    )}G available)`
            );
            return `${safeSizeGb}G`;
        }

        return fsSize;
    }
}

// ── Module-level helpers (shared, no class dependency) ──────────────

export async function sudoExec(
    command: string,
    args: string[],
    cwd: string
): Promise<void> {
    await exec.exec("sudo", [command, ...args], {
        cwd,
        silent: !core.isDebug()
    });
}

export async function execWithOutput(
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
    description: string,
    logPrefix: string
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `${logPrefix} Operation timed out after ${timeoutMs}ms: ${description}`
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

async function checkDiskSpace(
    targetPath: string,
    cwd: string,
    logPrefix: string
): Promise<number> {
    try {
        const output = await execWithOutput(
            "df",
            ["--output=avail", "-B1", targetPath],
            cwd
        );
        const lines = output.split("\n");
        const availStr = lines[lines.length - 1]?.trim();
        if (availStr) {
            const availBytes = parseInt(availStr, 10);
            const availMb = Math.floor(availBytes / (1024 * 1024));
            core.debug(`${logPrefix} Available disk space: ${availMb} MB`);

            if (availMb < MIN_DISK_HEADROOM_MB) {
                core.warning(
                    `${logPrefix} Low disk space: ${availMb} MB available ` +
                        `(minimum recommended: ${MIN_DISK_HEADROOM_MB} MB).`
                );
            }
            return availBytes;
        }
    } catch {
        core.debug(`${logPrefix} Could not check disk space (non-critical)`);
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
