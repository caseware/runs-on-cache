/**
 * NodeLocalCleanup — post-job cleanup of node-local BTRFS images.
 *
 * Policy (set via the cleanup-node-local input):
 *   "none"   — no cleanup; images stay on disk regardless of outcome
 *   "stale"  — (default) delete failed/cancelled; keep successful
 *   "always" — delete after every job, even if save succeeded
 */
import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Inputs } from "../../constants";

const LOG_PREFIX = "[NodeLocal cleanup]";

export type CleanupPolicy = "none" | "stale" | "always";

export async function cleanupNodeLocalImage(
    cacheKey: string,
    saveSafe: boolean,
    policy: CleanupPolicy
): Promise<void> {
    if (policy === "none") return;

    const nodeLocalCacheDir =
        core.getInput(Inputs.NodeLocalCacheDir) ||
        process.env["NODE_LOCAL_CACHE_DIR"] ||
        "";

    if (!nodeLocalCacheDir || !cacheKey) return;

    // Image-based backends (btrfs, xfs) persist a node-local WORM image that
    // needs the same stale-cleanup treatment. The on-disk extension matches
    // the backend (.btrfs / .xfs — XFS node-local images are RAW, uncompressed).
    const backend = (
        core.getState("CUSTOM_COMPRESSION") ||
        core.getInput(Inputs.CustomCompression) ||
        ""
    ).split("-")[0];

    const extension =
        backend === "btrfs" ? ".btrfs" : backend === "xfs" ? ".xfs" : null;

    if (!extension) return;

    const sanitizedKey = cacheKey.replace(/[/\\:*?"<>|]/g, "-");
    const localPath = path.join(
        nodeLocalCacheDir,
        `${sanitizedKey}${extension}`
    );

    try {
        await fs.access(localPath);
    } catch {
        core.debug(`${LOG_PREFIX} No node-local file found at ${localPath}`);
        return;
    }

    if (saveSafe && policy !== "always") {
        core.info(
            `${LOG_PREFIX} Save succeeded — keeping node-local image: ${path.basename(
                localPath
            )}`
        );
        return;
    }

    const reason = !saveSafe ? "stale (save skipped/failed)" : "policy=always";
    try {
        await fs.unlink(localPath);
        core.info(
            `${LOG_PREFIX} Deleted node-local image (${reason}): ${path.basename(
                localPath
            )}`
        );
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
            return;
        }
        core.warning(
            `${LOG_PREFIX} Failed to delete image ${path.basename(
                localPath
            )}: ${error instanceof Error ? error.message : error}`
        );
    }
}
