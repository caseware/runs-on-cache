/**
 * BtrfsCleanup — shared BTRFS mount + loop device cleanup utilities.
 *
 * Used by both the post-step (saveImpl.ts) and BtrfsContainer itself.
 * Consolidates the two separate implementations that previously existed.
 */
import * as core from "@actions/core";
import { execSync } from "node:child_process";
import * as path from "node:path";
import { tmpdir } from "node:os";

const LOG_PREFIX = "[BTRFS cleanup]";

/**
 * Clean up BTRFS mounts and loop devices belonging to a specific cache entry.
 * Scoped cleanup prevents one post step from killing mounts that other cache
 * entries still need for their save operations.
 *
 * @param cacheKey The cache key to scope cleanup to. If empty, falls back to global cleanup.
 */
export async function cleanupForCacheKey(cacheKey: string): Promise<void> {
    if (process.platform !== "linux") return;

    if (cacheKey) {
        const safeKey = cacheKey.replace(/[^a-zA-Z0-9\-_.]/g, "_");
        const baseTempDir = process.env["RUNNER_TEMP"] || tmpdir();
        const entryTempDir = path.join(baseTempDir, safeKey);

        core.info(`${LOG_PREFIX} Scoped cleanup for: ${entryTempDir}`);
        await scopedCleanup(entryTempDir);
    } else {
        core.info(
            `${LOG_PREFIX} No cache key — running global cleanup`
        );
        await globalCleanup();
    }
}

/**
 * Unmount only BTRFS mounts whose target starts with entryTempDir,
 * plus any bind mounts that originate from that directory.
 * Then detach only loop devices backing .btrfs files inside entryTempDir.
 */
async function scopedCleanup(entryTempDir: string): Promise<void> {
    try {
        const output = execSyncSafe(
            "findmnt -t btrfs -n -o TARGET,SOURCE"
        );
        if (!output) return;

        const allMounts = output
            .split("\n")
            .map(l => l.trim())
            .filter(l => l.length > 0);

        const ownedMounts: string[] = [];
        for (const line of allMounts) {
            const parts = line.split(/\s+/);
            const target = parts[0];
            const source = parts.slice(1).join(" ");
            if (
                target.startsWith(entryTempDir) ||
                source.includes(entryTempDir)
            ) {
                ownedMounts.push(target);
            }
        }

        // Find bind mounts whose source device maps back to our loop device
        let loopDevice = "";
        try {
            const losetupOutput = execSyncSafe("losetup -a");
            if (losetupOutput) {
                for (const line of losetupOutput.split("\n")) {
                    if (line.includes(entryTempDir)) {
                        loopDevice = line.split(":")[0];
                        break;
                    }
                }
            }
        } catch {
            /* no loop devices */
        }

        if (loopDevice) {
            for (const line of allMounts) {
                const parts = line.split(/\s+/);
                const target = parts[0];
                const source = parts.slice(1).join(" ");
                if (
                    source.includes(loopDevice) &&
                    !ownedMounts.includes(target)
                ) {
                    ownedMounts.push(target);
                }
            }
        }

        // Unmount in reverse order (bind mounts before main mount)
        ownedMounts.reverse();
        for (const mount of ownedMounts) {
            umountSafe(mount);
        }

        // Detach loop device
        if (loopDevice) {
            detachLoopDevice(loopDevice);
        }
    } catch {
        // findmnt not available or failed
    }
}

/**
 * Global fallback: clean up ALL BTRFS mounts and loop devices.
 * Only used when the cache key is unknown (restore failed before saving state).
 */
async function globalCleanup(): Promise<void> {
    try {
        const output = execSyncSafe("findmnt -t btrfs -n -o TARGET");
        if (!output) return;

        const mounts = output
            .split("\n")
            .map(m => m.trim())
            .filter(m => m.length > 0)
            .reverse();

        for (const mount of mounts) {
            umountSafe(mount);
        }

        try {
            const losetupOutput = execSyncSafe("losetup -a");
            if (losetupOutput) {
                const loopLines = losetupOutput
                    .split("\n")
                    .filter(l => l.includes(".btrfs"));
                for (const line of loopLines) {
                    const device = line.split(":")[0];
                    if (device) {
                        detachLoopDevice(device);
                    }
                }
            }
        } catch {
            /* no loop devices */
        }
    } catch {
        // findmnt not available or no BTRFS mounts
    }
}

/**
 * Check if a path is a mountpoint and unmount it if so.
 */
export function unmountIfMounted(targetPath: string, cwd: string): void {
    try {
        const rc = execSync(`mountpoint -q "${targetPath}" 2>/dev/null`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: "pipe"
        });
    } catch {
        return; // not a mountpoint or doesn't exist
    }
    // If we get here, it's a mountpoint
    core.warning(`${LOG_PREFIX} Stale mount detected at ${targetPath}, unmounting...`);
    umountSafe(targetPath);
}

// ── Helpers ─────────────────────────────────────────────────────────

function umountSafe(target: string): void {
    try {
        core.info(`${LOG_PREFIX} Unmounting: ${target}`);
        execSync(`sudo umount "${target}"`, {
            encoding: "utf8",
            timeout: 30000
        });
    } catch {
        try {
            execSync(`sudo umount -l "${target}"`, {
                encoding: "utf8",
                timeout: 30000
            });
        } catch {
            /* already unmounted */
        }
    }
}

function detachLoopDevice(device: string): void {
    core.info(`${LOG_PREFIX} Detaching loop device: ${device}`);
    try {
        execSync(`sudo losetup -d "${device}"`, {
            encoding: "utf8",
            timeout: 10000
        });
    } catch {
        /* already detached */
    }
}

function execSyncSafe(command: string): string {
    return execSync(command, {
        encoding: "utf8",
        timeout: 10000
    }).trim();
}
