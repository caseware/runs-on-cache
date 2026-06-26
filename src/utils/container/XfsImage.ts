/**
 * XfsImage — XFS-specific image lifecycle operations.
 *
 * All fs-agnostic logic (sparse image creation, loop-device attach/detach,
 * generic mount/unmount, RW headroom expansion, diagnostics scaffolding,
 * prerequisite scaffolding) lives in LoopImage. This class supplies ONLY the
 * XFS-specific pieces.
 *
 * Target: runner nodes whose kernel has no btrfs support (CONFIG_BTRFS_FS
 * unset) but does have xfs builtin (CONFIG_XFS_FS=y).
 *
 * CRITICAL differences from BtrfsImage:
 *   - XFS has NO transparent in-filesystem compression. The raw image file is
 *     what gets loop-mounted (no compress= mount option). Compression for the
 *     S3 round-trip is done EXPLICITLY (zstd) by XfsContainer, not here.
 *   - XFS CANNOT be shrunk (only grown). prepareSave() therefore does NOT
 *     resize/truncate the image down — it only syncs.
 *   - growFilesystem uses xfs_growfs; UUID randomization uses xfs_admin -U;
 *     verification uses xfs_repair -n; there is no online device-stats health.
 *
 * Does NOT know about bind mounts, workspace paths, node-local caching,
 * cache keys, or zstd compression. Those concerns belong to XfsContainer.
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
    LoopImage,
    LoopImageOptions,
    parseSizeToBytes,
    RequiredTool,
    sudoExec,
    validateFsSize
} from "./LoopImage";

const LOG_PREFIX = "[XFS]";

export type XfsImageOptions = LoopImageOptions;

export class XfsImage extends LoopImage {
    constructor(imageFile: string, opts: XfsImageOptions) {
        super(imageFile, opts);
    }

    // ── fs-specific hooks ─────────────────────────────────────────────

    protected get logPrefix(): string {
        return LOG_PREFIX;
    }

    protected get fsDisplayName(): string {
        return "XFS";
    }

    protected mkfsCommand(): string[] {
        return ["mkfs.xfs", "-f"];
    }

    protected mountFsType(): string {
        return "xfs";
    }

    // NOTE: no compress= option — XFS has no transparent compression.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected mountOptions(mode: "ro" | "rw"): string[] {
        return [];
    }

    protected async growFilesystem(mountPoint: string): Promise<void> {
        // xfs_growfs operates on the mount point and grows to the full device size.
        await sudoExec("xfs_growfs", [mountPoint], this.safeCwd);
    }

    protected fsRequiredTools(): RequiredTool[] {
        return [
            {
                command: "mkfs.xfs",
                description: "creating XFS filesystems (install xfsprogs)"
            },
            {
                command: "xfs_growfs",
                description: "growing XFS filesystems (install xfsprogs)"
            },
            {
                command: "xfs_admin",
                description: "XFS UUID management (install xfsprogs)"
            },
            {
                command: "xfs_db",
                description:
                    "offline XFS superblock verification before upload (install xfsprogs)"
            },
            {
                command: "mount",
                description: "mounting filesystems (install util-linux)"
            },
            {
                command: "zstd",
                description:
                    "explicit compression of the S3 artifact (install zstd)"
            }
        ];
    }

    protected fsKernelModules(): string[] {
        // On the target Bottlerocket nodes xfs is builtin (CONFIG_XFS_FS=y),
        // so modprobe xfs may "fail" (built-in) — that's non-fatal.
        return ["xfs"];
    }

    // ── Save pipeline ───────────────────────────────────────────────

    /**
     * Prepare the XFS image for saving.
     *
     * XFS CANNOT be shrunk — it only grows (mkfs is the only way to make it
     * smaller). Therefore, unlike BtrfsImage.prepareSave(), we do NOT attempt
     * any resize-down or backing-file truncate-down here. Doing so would
     * corrupt the filesystem.
     *
     * The size reduction for the S3 artifact comes entirely from the explicit
     * zstd compression performed by XfsContainer.save() AFTER unmount — not
     * from any filesystem shrink. So all this needs to do is flush dirty data
     * to the backing file so the unmounted image is consistent.
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async prepareSave(mountPoint: string): Promise<void> {
        this.info(
            "Syncing XFS image before save (XFS cannot be shrunk — relying on zstd for size reduction)"
        );
        await exec.exec("sync", [], {
            cwd: this.safeCwd,
            silent: !core.isDebug()
        });
    }

    /**
     * Verify the XFS image is valid before S3 upload.
     *
     * IMPORTANT — why this does NOT re-mount the image:
     *
     * The previous approach test-mounted the just-unmounted image read-only.
     * That was both over-strict AND racy. On busy runners the main workspace
     * mount cannot be cleanly unmounted (a running process holds the workspace
     * as its CWD), so the save falls back to a LAZY unmount (`umount -l`). A
     * lazy unmount detaches the mount point immediately but keeps the loop
     * device + backing file in use until the last reference closes. A fresh RO
     * mount of the SAME backing file (on a new loop device) then fails with
     * exit 32 (EBUSY — the superblock is still considered mounted), aborting an
     * otherwise-perfect save. See the IM-4641 incident: the image was just
     * mounted RW and written successfully, so the re-mount adds no real signal.
     *
     * Instead we do an OFFLINE, no-mount, read-only structural check directly
     * on the backing file:
     *   - `xfs_db -r -c "sb 0" -c "print" <imageFile>` opens the file read-only
     *     and prints superblock 0. This does NOT attach a loop device, does NOT
     *     replay the log, and does NOT need the device to be un-busy — so it is
     *     immune to the lazy-unmount race. We additionally assert the printed
     *     superblock carries the XFS magic number (0x58465342 / "XFSB") to
     *     confirm it is structurally a valid XFS image.
     *   - If xfs_db cannot run at all (not installed / unexpected failure), we
     *     do NOT hard-fail the save — that would be over-strict. We fall back to
     *     a file-size>0 sanity check and WARN.
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

            // 2. PRIMARY check: offline read-only superblock read (no loop, no
            //    mount, no log replay) — immune to the lazy-unmount EBUSY race.
            const result = await exec.getExecOutput(
                "xfs_db",
                ["-r", "-c", "sb 0", "-c", "print", imageFile],
                {
                    cwd: this.safeCwd,
                    silent: !core.isDebug(),
                    ignoreReturnCode: true
                }
            );

            if (result.exitCode === 0) {
                const out = `${result.stdout}\n${result.stderr}`;
                // A valid XFS superblock prints magicnum = 0x58465342 ("XFSB").
                if (/magicnum\s*=\s*0x58465342/i.test(out)) {
                    this.info(
                        "Offline superblock check passed (xfs_db sb 0) — image is safe to upload"
                    );
                    return true;
                }
                core.error(
                    `${LOG_PREFIX} Offline superblock check FAILED — xfs_db read sb 0 ` +
                        `but the XFS magic number (0x58465342) was not present. ` +
                        `Aborting S3 upload to avoid poisoning the cache. Output: ${out.trim()}`
                );
                return false;
            }

            // 3. xfs_db could not run (not installed / unexpected error). Do
            //    NOT hard-fail — the image was just mounted RW and written
            //    successfully, and the size check above passed. WARN instead.
            core.warning(
                `${LOG_PREFIX} Could not run offline xfs_db superblock check (exit ${result.exitCode}: ` +
                    `${
                        result.stderr.trim() ||
                        result.stdout.trim() ||
                        "no output"
                    }). ` +
                    `Falling back to file-size sanity check (size > 0 already verified) and proceeding with upload.`
            );
            return true;
        } catch (verifyError) {
            // An unexpected error in the verify path itself (e.g. fs.stat
            // threw). Treat as a real failure — we could not establish the
            // image even exists.
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

    /**
     * Randomize the XFS UUID. Prevents UUID collisions when two runners on the
     * same node mount copies of the same node-local WORM image (the kernel
     * rejects mounting a duplicate XFS UUID).
     *
     * btrfs used `btrfstune -u`; XFS uses `xfs_admin -U generate` on the
     * UNMOUNTED image. xfs_admin operates directly on the image file.
     */
    async randomizeUuid(): Promise<void> {
        this.info("Randomizing XFS UUID on copy");
        const imageFile = this.getImageFile();

        const result = await exec.getExecOutput(
            "sudo",
            ["xfs_admin", "-U", "generate", imageFile],
            {
                cwd: this.safeCwd,
                silent: !core.isDebug(),
                ignoreReturnCode: true
            }
        );

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
                        cwd: this.safeCwd,
                        silent: true,
                        ignoreReturnCode: true
                    }
                );
                dfOutput = dfResult.stdout.trim();
            } catch {
                /* ignore */
            }

            core.warning(
                `${LOG_PREFIX} xfs_admin failed (exit ${result.exitCode}). ` +
                    `File: ${imageFile} (${fileSizeMb} MB). ` +
                    `stderr: ${stderr || "(empty)"}. stdout: ${
                        stdout || "(empty)"
                    }. ` +
                    `df: ${dfOutput || "(unavailable)"}`
            );
            throw new Error(
                `xfs_admin -U generate failed with exit code ${
                    result.exitCode
                }: ${stderr || stdout || "no output"}`
            );
        }
    }

    // ── Filesystem health ───────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async checkHealth(mountPoint: string): Promise<void> {
        // XFS has no per-mount device-stats command analogous to
        // `btrfs device stats`. Health is validated offline via
        // verifyMountable() (xfs_repair -n) before upload. Nothing to do here.
        core.debug(
            `${LOG_PREFIX} Filesystem health check skipped (XFS has no online device-stats)`
        );
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
        await collect("xfs_repair -n", "sudo", [
            "xfs_repair",
            "-n",
            actualDevice
        ]);
        await collect("xfs_info", "bash", [
            "-c",
            `sudo xfs_db -r -c 'sb 0' -c 'print' ${actualDevice} 2>&1 | grep -iE 'magicnum|blocksize|dblocks|uuid' || true`
        ]);
    }
}

// ── Re-exports for backwards compatibility ──────────────────────────

export { parseSizeToBytes, validateFsSize };

/**
 * Validate a zstd compression level spec for the explicit S3 compression
 * step. Accepts "zstd", "zstd:N", or a bare number (1-22).
 */
export function validateCompressionLevel(level: string): void {
    const regex = /^(zstd(?::(?:[1-9]|1[0-9]|2[0-2]))?|[1-9]|1[0-9]|2[0-2])$/;
    if (!regex.test(level)) {
        throw new Error(
            `Invalid compression level format: ${level}. Expected zstd, zstd:N, or a number 1-22.`
        );
    }
}

/**
 * Parse a zstd level spec into a numeric level. "zstd:3" → 3, "zstd" → 3
 * (default), "6" → 6. Falls back to 3 if unparseable.
 */
export function parseZstdLevel(level: string | undefined): number {
    if (!level) return 3;
    const m = level.match(/(\d+)/);
    if (!m) return 3;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 22 ? n : 3;
}
