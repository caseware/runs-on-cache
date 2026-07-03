/**
 * Ext4UpperImage — a DEDICATED, throwaway ext4 loop image used ONLY as the
 * RW upperdir+workdir of a consumer overlay.
 *
 * Why this exists (the O(1)-teardown problem):
 *   The consumer overlay's upper holds the job's copy-up deltas — up to ~700k
 *   real files (node_modules rewrite, `cp -rf` devkits, build output). The
 *   `volatile` overlay makes the *umount* free, but reclaiming those files then
 *   costs a recursive `rm -rf` of the upper dir on the shared node-local disk —
 *   ~56s on the runner's critical path. Backing the upper with its own loop
 *   image turns that into: unmount the image + delete ONE backing file →
 *   the whole filesystem (and every inode in it) is freed at once. O(1).
 *
 * Why NOT the cache WORM image machinery (XfsImage/LoopImage):
 *   The upper is throwaway — never saved, never uploaded, no UUID dedup, no
 *   verify, no headroom growth. It needs only: create → mount RW → unmount +
 *   delete. So this is a small self-contained class, not a LoopImage subclass.
 *
 * Performance design (learned the hard way — the sparse-XFS-on-loop attempt
 * stalled for 17 min on a live job):
 *   1. `fallocate -l <size>` FULL (non-sparse). A sparse backing file forces
 *      the HOST fs to allocate an extent (a host-journal metadata txn) on the
 *      FIRST write to every block — i.e. per-block host-fs journaling amortized
 *      across ~700k copy-ups. fallocate pre-allocates all host extents up front
 *      in a handful of big-extent transactions, so copy-up writes hit
 *      already-allocated blocks → NO host-fs allocation on the hot path.
 *   2. `mkfs.ext4 -O ^has_journal` — the upper is throwaway, so its own journal
 *      buys nothing and only adds write traffic (xlog commits were half the
 *      stall). No guest journal → no guest-journal txns on copy-up.
 *   3. `losetup --direct-io=on` — bypass the host page cache for the loop
 *      device, so dirty pages don't pile up and trip block-layer writeback
 *      throttling (rq_qos_wait/wbt_wait — the other half of the stall).
 *   4. mount `noatime,nobarrier` — no atime writes; barriers are moot without a
 *      journal and the upper needs zero durability.
 *
 * NO live growth: growing a mounted loop fs needs `losetup -c` on the attached
 * device, which is the exact operation that corrupted a just-recovered fs
 * before (see LoopImage.growBackingFile's warm-restore corruption note). The
 * backing file is fallocated to its full size ONCE, up front, and never grown.
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";

import { parseSizeToBytes } from "./LoopImage";

const LOG_PREFIX = "[Ext4Upper]";

export class Ext4UpperImage {
    private readonly imageFile: string;
    private readonly safeCwd: string;
    /** The loop device this image is attached to while mounted (e.g. /dev/loop3). */
    private loopDevice: string | undefined;

    constructor(imageFile: string, safeCwd: string) {
        this.imageFile = imageFile;
        this.safeCwd = safeCwd;
    }

    private info(msg: string): void {
        core.info(`${LOG_PREFIX} ${msg}`);
    }

    getImageFile(): string {
        return this.imageFile;
    }

    /**
     * Create the backing file (fallocate FULL — non-sparse) and format it as a
     * no-journal ext4. `size` is a human string like "4G" / "3200M".
     *
     * fallocate reserves the whole size on the host disk immediately; if the
     * host doesn't have the room, fallocate fails HERE (before any mount), and
     * the caller falls back to a plain-dir upper.
     */
    async create(size: string): Promise<void> {
        const bytes = parseSizeToBytes(size);
        this.info(
            `Allocating full (non-sparse) upper image: ${this.imageFile} (${size} = ${bytes} bytes)`
        );
        // fallocate FULL — reserves all host extents up front so copy-up writes
        // never trigger host-fs allocation/journaling on the hot path.
        await exec.exec("fallocate", ["-l", `${bytes}`, this.imageFile], {
            cwd: this.safeCwd
        });
        this.info("Formatting upper image as ext4 (no journal)");
        // -F: force (operate on a file). -O ^has_journal: NO journal (throwaway
        // upper). lazy_*_init=0: do inode/journal table init at mkfs time so the
        // first writes aren't slowed by lazy background init on the hot path.
        await exec.exec(
            "mkfs.ext4",
            [
                "-F",
                "-O",
                "^has_journal",
                "-E",
                "lazy_itable_init=0,lazy_journal_init=0",
                this.imageFile
            ],
            { cwd: this.safeCwd, silent: !core.isDebug() }
        );
    }

    /**
     * Attach the image to a fresh loop device with direct-io ON, then mount it
     * RW at `mountPoint`. Records the loop device for unmount().
     */
    async mountRW(mountPoint: string): Promise<void> {
        // Attach with direct-io=on so loop writes bypass the host page cache
        // (avoids dirty-page pileup → block-layer writeback throttling).
        const attach = await exec.getExecOutput(
            "sudo",
            [
                "losetup",
                "--find",
                "--show",
                "--direct-io=on",
                this.imageFile
            ],
            { cwd: this.safeCwd }
        );
        const dev = attach.stdout.trim();
        if (!dev) {
            throw new Error(
                `losetup did not return a loop device for ${this.imageFile}`
            );
        }
        this.loopDevice = dev;
        this.info(`Attached ${this.imageFile} → ${dev} (direct-io=on)`);

        // Mount noatime,nobarrier. nobarrier is moot without a journal and the
        // upper needs zero durability. If the kernel rejects nobarrier, retry
        // with noatime alone so a picky kernel can't fail the whole mount.
        const mount = await exec.getExecOutput(
            "sudo",
            ["mount", "-t", "ext4", "-o", "noatime,nobarrier", dev, mountPoint],
            { cwd: this.safeCwd, ignoreReturnCode: true }
        );
        if (mount.exitCode !== 0) {
            core.warning(
                `${LOG_PREFIX} mount with noatime,nobarrier failed (exit ${mount.exitCode}: ` +
                    `${mount.stderr.trim() || mount.stdout.trim()}); retrying with noatime only`
            );
            await exec.exec(
                "sudo",
                ["mount", "-t", "ext4", "-o", "noatime", dev, mountPoint],
                { cwd: this.safeCwd }
            );
        }
        this.info(`Mounted ${dev} → ${mountPoint} (ext4, noatime)`);
    }

    /**
     * Unmount the image and detach its loop device. Best-effort + lazy-unmount
     * fallback so a busy mount can't wedge teardown. Safe to call when the loop
     * device is only known from a fresh cross-process re-detection (pass it via
     * setLoopDevice() first).
     */
    async unmount(mountPoint: string): Promise<void> {
        const um = await exec.getExecOutput("sudo", ["umount", mountPoint], {
            cwd: this.safeCwd,
            ignoreReturnCode: true
        });
        if (um.exitCode !== 0) {
            core.warning(
                `${LOG_PREFIX} umount ${mountPoint} failed (exit ${um.exitCode}); trying lazy umount`
            );
            await exec
                .getExecOutput("sudo", ["umount", "-l", mountPoint], {
                    cwd: this.safeCwd,
                    ignoreReturnCode: true
                })
                .catch(() => undefined);
        }
        if (this.loopDevice) {
            await exec
                .getExecOutput("sudo", ["losetup", "-d", this.loopDevice], {
                    cwd: this.safeCwd,
                    ignoreReturnCode: true
                })
                .catch(() => undefined);
            this.info(`Detached loop device ${this.loopDevice}`);
            this.loopDevice = undefined;
        }
    }

    /**
     * Set the loop device explicitly — used by the SAVE process, which is a
     * fresh instance that didn't attach the device and must re-derive it from
     * the live mount (findmnt SOURCE) before unmounting.
     */
    setLoopDevice(dev: string): void {
        this.loopDevice = dev;
    }
}
