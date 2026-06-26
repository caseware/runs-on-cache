/**
 * BtrfsImage — BTRFS-specific image lifecycle operations.
 *
 * All fs-agnostic logic (sparse image creation, loop-device attach/detach,
 * generic mount/unmount, RW headroom expansion, diagnostics scaffolding,
 * prerequisite scaffolding) lives in LoopImage. This class supplies ONLY the
 * BTRFS-specific pieces: compress= mount options, defrag+resize+truncate save
 * pipeline, dump-super verification, btrfstune UUID randomization, and
 * `btrfs device stats` health.
 *
 * Does NOT know about bind mounts, workspace paths, node-local caching, or
 * cache keys. Those concerns belong to BtrfsContainer (the orchestrator).
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
    execWithOutput,
    LoopImage,
    LoopImageOptions,
    parseSizeToBytes,
    RequiredTool,
    sudoExec,
    validateFsSize
} from "./LoopImage";

const LOG_PREFIX = "[BTRFS]";

export interface BtrfsImageOptions extends LoopImageOptions {
    compressionLevel: string;
    saveCompressionLevel: string;
    /** Buffer added on SAVE — small metadata overhead only (default 128 MB). */
    saveBufferBytes: number;
}

export class BtrfsImage extends LoopImage {
    constructor(imageFile: string, private opts: BtrfsImageOptions) {
        super(imageFile, opts);
    }

    // ── fs-specific hooks ─────────────────────────────────────────────

    protected get logPrefix(): string {
        return LOG_PREFIX;
    }

    protected get fsDisplayName(): string {
        return "BTRFS";
    }

    protected mkfsCommand(): string[] {
        return ["mkfs.btrfs", "-f"];
    }

    protected mountFsType(): string {
        return "btrfs";
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected mountOptions(mode: "ro" | "rw"): string[] {
        return [`compress=${this.opts.compressionLevel}`];
    }

    protected async growFilesystem(mountPoint: string): Promise<void> {
        await sudoExec(
            "btrfs",
            ["filesystem", "resize", "max", mountPoint],
            this.opts.safeCwd
        );
    }

    protected fsRequiredTools(): RequiredTool[] {
        return [
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
            }
        ];
    }

    protected fsKernelModules(): string[] {
        return ["btrfs"];
    }

    // ── Save pipeline: defrag → resize → unmount → truncate → verify ──

    async prepareSave(mountPoint: string): Promise<void> {
        const defragAlgo = this.opts.saveCompressionLevel.split(":")[0];

        // Remount with save-level compression before defrag
        this.info(
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
        this.info(
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

        // Minimum 64 MB headroom beyond Device allocated — BTRFS internal
        // structures (backup superblocks at 64 MB, chunk-tree slack) may
        // reference offsets past the reported allocation.  Without this,
        // btrfstune (UUID randomization on restore) fails with
        // "No valid Btrfs found" on the truncated image.
        const MIN_STRUCTURAL_HEADROOM = 64 * 1024 * 1024; // 64 MB
        const buffer = Math.max(
            this.opts.saveBufferBytes,
            MIN_STRUCTURAL_HEADROOM
        );
        const targetSize = usedBytes + buffer;
        const targetMb = Math.max(1, Math.ceil(targetSize / (1024 * 1024)));

        this.info(
            `Resize target: ${targetMb} MB (effective usage: ${Math.ceil(
                usedBytes / (1024 * 1024)
            )} MB + ${Math.ceil(buffer / (1024 * 1024))} MB headroom)`
        );
        try {
            await exec.exec(
                "sudo",
                ["btrfs", "filesystem", "resize", `${targetMb}M`, mountPoint],
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
                    ["-s", `${targetMb}M`, this.getImageFile()],
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
            this.info(
                "Skipping backing file truncation — filesystem resize did not succeed"
            );
        }

        await exec.exec("sync", [], {
            cwd: this.opts.safeCwd,
            silent: !core.isDebug()
        });
    }

    /**
     * Verify the BTRFS image is valid before S3 upload using offline
     * superblock inspection. This avoids the loop-device and UUID-collision
     * issues that plague mount-based verification after lazy unmount.
     *
     * Checks:
     *  1. File exists and is non-empty
     *  2. `btrfs inspect-internal dump-super` exits 0 (validates superblock,
     *     magic number, checksums, generation counters)
     */
    async verifyMountable(): Promise<boolean> {
        this.info("Verifying image integrity before upload...");
        try {
            const imageFile = this.getImageFile();
            // 1. File existence + size sanity check
            const stat = await fs.stat(imageFile);
            if (stat.size === 0) {
                core.error(`${LOG_PREFIX} Image file is empty (0 bytes)`);
                return false;
            }
            this.info(
                `Image file size: ${Math.round(stat.size / 1024 / 1024)} MB`
            );

            // 2. BTRFS superblock validation (offline, no loop device needed)
            //    dump-super returns non-zero if the superblock is unreadable.
            //    Use getExecOutput for reliable stdout/stderr capture (the
            //    listener pattern can miss output when the runner's CWD is
            //    invalid after lazy unmount).
            const result = await exec.getExecOutput(
                "sudo",
                ["btrfs", "inspect-internal", "dump-super", imageFile],
                {
                    cwd: "/tmp",
                    silent: !core.isDebug(),
                    ignoreReturnCode: true
                }
            );

            if (result.exitCode !== 0) {
                core.error(
                    `${LOG_PREFIX} dump-super exited ${
                        result.exitCode
                    } — image may be corrupted. stderr: ${result.stderr.slice(
                        0,
                        500
                    )}`
                );
                return false;
            }

            // Extra sanity: if we got stdout, check for key fields
            const output = result.stdout;
            if (
                output.length > 0 &&
                (!output.includes("magic") || !output.includes("generation"))
            ) {
                core.warning(
                    `${LOG_PREFIX} dump-super exited 0 but output (${output.length} bytes) missing expected fields — proceeding anyway`
                );
            }

            this.info(
                "Superblock validation succeeded — image is safe to upload"
            );
            return true;
        } catch (verifyError) {
            core.error(
                `Verification FAILED — aborting S3 upload to prevent poisoning cache: ${
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
        this.info("Randomizing BTRFS UUID on copy");
        const imageFile = this.getImageFile();

        // Attach to a loop device first — btrfstune is more reliable on block
        // devices than on raw files (especially after truncate to exact size).
        let loopDev: string | undefined;
        try {
            const loResult = await exec.getExecOutput(
                "sudo",
                ["losetup", "--find", "--show", imageFile],
                {
                    cwd: this.opts.safeCwd,
                    silent: !core.isDebug(),
                    ignoreReturnCode: true
                }
            );
            if (loResult.exitCode === 0 && loResult.stdout.trim()) {
                loopDev = loResult.stdout.trim();
                this.info(
                    `Attached ${imageFile} → ${loopDev} for UUID randomization`
                );
            }
        } catch {
            /* fall through to file-based approach */
        }

        const target = loopDev || imageFile;
        const result = await exec.getExecOutput(
            "sudo",
            ["btrfstune", "-f", "-u", target],
            {
                cwd: this.opts.safeCwd,
                silent: !core.isDebug(),
                ignoreReturnCode: true
            }
        );

        // Always detach loop device, even on failure
        if (loopDev) {
            try {
                await exec.exec("sudo", ["losetup", "-d", loopDev], {
                    cwd: this.opts.safeCwd,
                    silent: true,
                    ignoreReturnCode: true
                });
            } catch {
                /* best-effort */
            }
        }

        if (result.exitCode !== 0) {
            const stderr = result.stderr.trim();
            const stdout = result.stdout.trim();
            let fileSizeMb = "unknown";
            try {
                const stat = await fs.stat(imageFile);
                fileSizeMb = `${Math.round(stat.size / (1024 * 1024))}`;
            } catch {
                /* ignore */
            }

            let dfOutput = "";
            try {
                const dfResult = await exec.getExecOutput(
                    "df",
                    ["-h", path.dirname(imageFile)],
                    {
                        cwd: this.opts.safeCwd,
                        silent: true,
                        ignoreReturnCode: true
                    }
                );
                dfOutput = dfResult.stdout.trim();
            } catch {
                /* ignore */
            }

            core.warning(
                `${LOG_PREFIX} btrfstune failed (exit ${result.exitCode}). ` +
                    `Target: ${target}. File: ${imageFile} (${fileSizeMb} MB). ` +
                    `stderr: ${stderr || "(empty)"}. stdout: ${
                        stdout || "(empty)"
                    }. ` +
                    `df: ${dfOutput || "(unavailable)"}`
            );
            throw new Error(
                `btrfstune -f -u failed with exit code ${result.exitCode}: ${
                    stderr || stdout || "no output"
                }`
            );
        }
    }

    // ── Filesystem health ───────────────────────────────────────────

    async checkHealth(mountPoint: string): Promise<void> {
        try {
            const output = await execWithOutput(
                "sudo",
                ["btrfs", "device", "stats", mountPoint],
                this.opts.safeCwd
            );

            const errorLines = output.split("\n").filter(line => {
                const match = line.match(/\.(\w+_errs)\s+(\d+)/);
                return match && parseInt(match[2], 10) > 0;
            });

            if (errorLines.length > 0) {
                core.warning(
                    `${LOG_PREFIX} Filesystem has I/O errors:\n${errorLines.join(
                        "\n"
                    )}` + `\nConsider recreating the cache image.`
                );
            } else {
                core.debug(
                    `${LOG_PREFIX} Filesystem health check: no errors detected`
                );
            }
        } catch {
            core.debug(
                `${LOG_PREFIX} Could not check filesystem health (non-critical)`
            );
        }
    }

    // ── fs-specific mount diagnostics (debug-only) ───────────────────

    protected async collectFsMountDiagnostics(
        actualDevice: string,
        collect: (
            label: string,
            cmd: string,
            cmdArgs: string[]
        ) => Promise<void>
    ): Promise<void> {
        await exec
            .exec(
                "bash",
                [
                    "-c",
                    "command -v btrfs >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y -qq btrfs-progs 2>/dev/null) || true"
                ],
                { cwd: this.opts.safeCwd, silent: true }
            )
            .catch(() => {
                /* best-effort tool install */
            });
        await collect("btrfs check --readonly", "sudo", [
            "btrfs",
            "check",
            "--readonly",
            actualDevice
        ]);
        await collect("btrfs superblock (compat flags)", "bash", [
            "-c",
            `sudo btrfs inspect-internal dump-super ${actualDevice} 2>&1 | grep -iE 'compat|magic|generation|sectorsize|nodesize|root_level'`
        ]);
    }

    // ── Private BTRFS-usage parsing ──────────────────────────────────

    private async getBtrfsUsage(mountPoint: string): Promise<string> {
        return execWithOutput(
            "sudo",
            ["btrfs", "filesystem", "usage", "-b", mountPoint],
            this.opts.safeCwd
        );
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
}

// ── Re-exports for backwards compatibility ──────────────────────────

export { parseSizeToBytes, validateFsSize };

export function validateCompressionLevel(level: string): void {
    const regex = /^(zlib(?:[:][1-9])?|lzo|zstd(?::-?(?:[0-9]|1[0-5]))?)$/;
    if (!regex.test(level)) {
        throw new Error(`Invalid compression level format: ${level}.`);
    }
}
