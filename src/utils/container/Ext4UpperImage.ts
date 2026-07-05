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
 * Performance + sizing design (all measured on-node — see below):
 *   1. SPARSE, LARGE virtual size (`truncate -s <bigSize>`, NOT fallocate-full).
 *      The upper holds only the job's copy-up DELTA (build output, dist/, cp-rf
 *      devkits) — NOT node_modules (that's in the RO lower) — so real usage is
 *      typically a few hundred MB. A large VIRTUAL size gives generous headroom
 *      (no in-image ENOSPC / fill-race) while consuming ~0 real host bytes until
 *      written (allocate-on-write). This is critical because the image is
 *      created PER JOB × N concurrent runner pods on the SHARED node-local
 *      hostPath: fallocate-FULL would reserve size×N and exhaust that disk;
 *      sparse reserves ~nothing. Measured on a live node: 20G sparse ext4 = 325
 *      MB real after mkfs vs 4097 MB for fallocate-full 4G.
 *   2. `mkfs.ext4 -O ^has_journal` — throwaway upper, no journal needed; also
 *      avoids the guest-journal write traffic.
 *   3. `losetup --direct-io=on` — bypass the host page cache so dirty pages
 *      don't pile up and trip block-layer writeback throttling.
 *   4. mount `noatime,nobarrier` — no atime; barriers moot without a journal.
 *
 * WHY SPARSE IS SAFE HERE (the earlier 17-min stall was XFS, not sparse): that
 * stall was sparse XFS-on-loop, where XFS's CIL journal storms on per-block
 * host allocation. A NO-JOURNAL ext4 has no such journal. Measured on-node: a
 * 20G sparse no-journal ext4 writes 2GB at 140 MB/s — identical to fallocate-
 * full 4G (140 MB/s) — i.e. ZERO throughput penalty and no stall. So sparse-
 * large removes host-exhaustion AND the fill-race AND needs no grow-watcher /
 * live `losetup -c` (which is what forbade growing the WORM XFS image).
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
     * Create the backing file (SPARSE, via truncate) and format it as a
     * no-journal ext4. `size` is the VIRTUAL size (e.g. "20G") — real host
     * bytes are consumed only as the overlay copies up (allocate-on-write), so
     * a large virtual size is cheap and gives generous in-image headroom.
     */
    async create(size: string): Promise<void> {
        const bytes = parseSizeToBytes(size);
        this.info(
            `Creating sparse upper image: ${this.imageFile} (virtual ${size} = ${bytes} bytes; real bytes grow on write)`
        );
        // truncate → sparse file at the virtual size. NOT fallocate: the image
        // is created per-job × N runner pods on the shared node-local hostPath,
        // so full reservation would exhaust that disk. Measured: 20G sparse
        // ext4 = ~325 MB real after mkfs vs 4 GB for fallocate-full.
        await exec.exec("truncate", ["-s", `${bytes}`, this.imageFile], {
            cwd: this.safeCwd
        });
        this.info("Formatting upper image as ext4 (no journal)");
        // -F: force (operate on a file). -O ^has_journal: NO journal (throwaway
        // upper — also why sparse is safe: no journal means no CIL storm on
        // per-block host allocation, the XFS-on-loop stall we hit before; a
        // no-journal ext4 writes at full disk speed sparse, measured 140 MB/s).
        // lazy_*_init=0: init tables at mkfs so first writes aren't slowed by
        // lazy background init.
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
        // NOTE: no `--autoclear` flag — the runner's util-linux (Ubuntu 20.04)
        // rejects that long option and would fail the whole attach. Autoclear is
        // armed PORTABLY below via a deferred `losetup -d` after the mount.
        const attach = await exec.getExecOutput(
            "sudo",
            ["losetup", "--find", "--show", "--direct-io=on", this.imageFile],
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
                    `${
                        mount.stderr.trim() || mount.stdout.trim()
                    }); retrying with noatime only`
            );
            await exec.exec(
                "sudo",
                ["mount", "-t", "ext4", "-o", "noatime", dev, mountPoint],
                { cwd: this.safeCwd }
            );
        }
        this.info(`Mounted ${dev} → ${mountPoint} (ext4, noatime)`);

        // Portable autoclear: `losetup -d` on the now-mounted device does not
        // detach immediately (the mount holds it) but marks LO_FLAGS_AUTOCLEAR,
        // so the loop auto-frees when the overlay is (lazily) unmounted at job
        // end — the kubelet then inherits no attached loop to reap. Works on all
        // util-linux versions (unlike the `--autoclear` attach flag).
        try {
            await exec.exec("sudo", ["losetup", "-d", dev], {
                cwd: this.safeCwd,
                silent: !core.isDebug()
            });
            core.debug(
                `${LOG_PREFIX} Armed autoclear (deferred detach) on ${dev}`
            );
        } catch {
            /* non-fatal: falls back to explicit detach in unmount() */
        }
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
