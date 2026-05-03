/**
 * NodeLocalCleanup — post-job cleanup of node-local BTRFS images.
 *
 * After a runner job finishes, the node-local image is either:
 *   - Dead (job cancelled/failed, save skipped) → delete it
 *   - Safe (save succeeded, image committed back to node-local) → keep it
 *     (unless the consumer opted into always-cleanup via cleanup-node-local)
 *
 * Without this cleanup, stale images from cancelled/failed jobs accumulate
 * on the node until external eviction kicks in (hours/days).
 */
import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Inputs } from "../../constants";

const LOG_PREFIX = "[NodeLocal cleanup]";

/**
 * Clean up the node-local image after a job completes.
 *
 * @param cacheKey       The cache key used for this entry.
 * @param saveSafe       Whether the save completed successfully.
 * @param alwaysCleanup  When true, delete the image even if save succeeded.
 */
export async function cleanupNodeLocalImage(
    cacheKey: string,
    saveSafe: boolean,
    alwaysCleanup: boolean
): Promise<void> {
    const nodeLocalCacheDir =
        core.getInput(Inputs.NodeLocalCacheDir) ||
        process.env["NODE_LOCAL_CACHE_DIR"] ||
        "";

    if (!nodeLocalCacheDir || !cacheKey) return;

    const isBtrfs = (
        core.getState("CUSTOM_COMPRESSION") ||
        core.getInput(Inputs.CustomCompression) ||
        ""
    ) === "btrfs";

    if (!isBtrfs) return;

    const sanitizedKey = cacheKey.replace(/[/\\:*?"<>|]/g, "-");
    const localPath = path.join(nodeLocalCacheDir, `${sanitizedKey}.btrfs`);

    try {
        await fs.access(localPath);
    } catch {
        core.debug(`${LOG_PREFIX} No node-local file found at ${localPath}`);
        return;
    }

    if (saveSafe && !alwaysCleanup) {
        core.info(
            `${LOG_PREFIX} Save succeeded — keeping node-local image: ${path.basename(localPath)}`
        );
        return;
    }

    const reason = !saveSafe ? "stale (save skipped/failed)" : "cleanup-node-local enabled";
    try {
        await fs.unlink(localPath);
        core.info(
            `${LOG_PREFIX} Deleted node-local image (${reason}): ${path.basename(localPath)}`
        );
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            return;
        }
        core.warning(
            `${LOG_PREFIX} Failed to delete image ${path.basename(localPath)}: ${
                error instanceof Error ? error.message : error
            }`
        );
    }
}
