import * as core from "@actions/core";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

const STALE_TEMP_FILE_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * NodeLocalCache provides node-level persistent caching via a HostPath-mounted directory.
 *
 * Architecture:
 *   /opt/local-volumes/btrfs-cache/   (HostPath mount on EKS nodes)
 *     ├── <cache-key>.btrfs           (final WORM images)
 *     ├── <cache-key>.tar.lz4         (final tar archives)
 *     └── .temp<random>.btrfs         (in-progress population, cleaned after 12h)
 *
 * Flow:
 *   1. Check if node-local file exists for the cache key → instant mount (~1-2s)
 *   2. If missing, download from S3 → write to .tempXXX → atomic mv → mount
 *   3. Prune stale .temp* files older than 12 hours
 *
 * This class is shared by BtrfsContainer, VhdxContainer, TarLz4Container, and TarContainer.
 */
export class NodeLocalCache {
    private readonly cacheDir: string;
    private readonly cacheKey: string;
    private readonly extension: string;

    constructor(cacheDir: string, cacheKey: string, extension: string) {
        this.cacheDir = cacheDir;
        this.cacheKey = cacheKey;
        this.extension = extension;
    }

    /**
     * Whether node-local caching is enabled (non-empty cacheDir).
     */
    get enabled(): boolean {
        return this.cacheDir.length > 0;
    }

    /**
     * The final path for this cache key on the node.
     * e.g. /opt/local-volumes/btrfs-cache/<cache-key>.btrfs
     */
    get localPath(): string {
        return path.join(this.cacheDir, `${this.sanitizeKey(this.cacheKey)}${this.extension}`);
    }

    /**
     * Check if a node-local image already exists for this cache key.
     */
    async exists(): Promise<boolean> {
        if (!this.enabled) return false;

        try {
            await fs.access(this.localPath);
            core.info(`[NodeLocal] Cache hit: ${this.localPath}`);
            return true;
        } catch {
            core.debug(`[NodeLocal] Cache miss: ${this.localPath}`);
            return false;
        }
    }

    /**
     * Whether a node-local image was placed by the cache-warmer DaemonSet
     * (pre-warmed) vs left by a prior runner on this node. The cache-warmer
     * writes a sidecar stamp file "<image>.prewarmed" next to images it
     * prestages; its presence distinguishes "prewarmed" from "node-local" for
     * metrics. Best-effort: returns false if the stamp is absent/unreadable.
     */
    async isPrewarmed(imagePath: string = this.localPath): Promise<boolean> {
        try {
            await fs.access(`${imagePath}.prewarmed`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create a temp file path for atomic population.
     * Returns the path to write to before calling commitTempFile().
     */
    async createTempFile(): Promise<string | null> {
        if (!this.enabled) return null;

        try {
            // Ensure the cache directory exists and is writable by the current user.
            // HostPath volumes are created as root by kubelet; runners run as UID 1001.
            // Try without sudo first; fall back to sudo if permission denied.
            try {
                await fs.mkdir(this.cacheDir, { recursive: true });
                await fs.access(this.cacheDir, (await import("fs")).constants.W_OK);
            } catch {
                // mkdir or access failed — try with sudo (runners have privileged: true)
                const { exec: execCmd } = await import("@actions/exec");
                await execCmd("sudo", ["mkdir", "-p", this.cacheDir], { silent: true });
                // getuid/getgid are typed optional (undefined on Windows) under
                // @types/node 24; this path is Linux-runner-only, so assert.
                await execCmd("sudo", ["chown", `${process.getuid!()}:${process.getgid!()}`, this.cacheDir], { silent: true });
                await fs.access(this.cacheDir, (await import("fs")).constants.W_OK);
            }

            const randomSuffix = crypto.randomBytes(8).toString("hex");
            const tempPath = path.join(
                this.cacheDir,
                `.temp${randomSuffix}${this.extension}`
            );
            core.debug(`[NodeLocal] Created temp path: ${tempPath}`);
            return tempPath;
        } catch (error) {
            core.warning(
                `[NodeLocal] Cannot write to cache dir ${this.cacheDir}: ${
                    error instanceof Error ? error.message : error
                }. Falling back to S3-only mode.`
            );
            return null;
        }
    }

    /**
     * Atomically move the temp file to the final cache location.
     * If another runner already placed a file there, silently succeeds
     * (the temp file is removed and we use the existing one).
     *
     * Returns true if this runner "won" the race, false if another runner beat us.
     */
    async commitTempFile(tempPath: string): Promise<boolean> {
        if (!this.enabled) return false;

        const finalPath = this.localPath;

        try {
            // Check if final path already exists (another runner beat us)
            try {
                await fs.access(finalPath);
                // Another runner already placed it — clean up our temp and move on
                core.info(`[NodeLocal] Another runner already populated ${finalPath} — skipping`);
                await this.removeSafe(tempPath);
                return false;
            } catch {
                // Good — no existing file, we proceed with the mv
            }

            // Atomic rename: .tempXXX → <cache-key>.ext
            await fs.rename(tempPath, finalPath);
            // This image was just DOWNLOADED from S3 by a runner — it is NOT a
            // DaemonSet-prestaged ("prewarmed") image. Remove any stale
            // `.prewarmed` stamp left by a prior prestage so cache-source is
            // reported as "node-local"/"s3", not mislabeled "prewarmed".
            // (Only the cache-warmer/cache-transfer DaemonSet writes that stamp;
            // isPrewarmed() keys off its presence.)
            await this.removeSafe(`${finalPath}.prewarmed`);
            core.info(`[NodeLocal] Committed: ${finalPath}`);
            return true;
        } catch (error) {
            // rename can fail with ENOTEMPTY or EEXIST on race — that's fine
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOTEMPTY" || code === "EEXIST") {
                core.info(`[NodeLocal] Race detected on commit — another runner won. Cleaning up.`);
                await this.removeSafe(tempPath);
                return false;
            }
            // Unexpected error — log but don't fail the job
            core.warning(
                `[NodeLocal] Failed to commit temp file: ${
                    error instanceof Error ? error.message : error
                }`
            );
            await this.removeSafe(tempPath);
            return false;
        }
    }

    /**
     * Get the path where S3 should download the archive to.
     * When node-local caching is enabled, returns a .tempXXX path in the HostPath dir
     * so the download goes directly to the right place (no copy needed).
     * When disabled, returns null (caller uses default temp dir).
     */
    async getDownloadPath(): Promise<string | null> {
        if (!this.enabled) return null;

        try {
            return await this.createTempFile();
        } catch (error) {
            core.warning(
                `[NodeLocal] Failed to create download path, falling back to default: ${
                    error instanceof Error ? error.message : error
                }`
            );
            return null;
        }
    }

    /**
     * Clean up stale .temp* files older than 12 hours.
     * Should be called at the start of every job.
     */
    async cleanupStaleTempFiles(): Promise<number> {
        if (!this.enabled) return 0;

        let cleaned = 0;
        try {
            const entries = await fs.readdir(this.cacheDir);
            const now = Date.now();

            for (const entry of entries) {
                // .temp*  → in-progress S3 downloads
                // .overlay-* → per-job overlay upper/work dirs (k8s places these
                //   on the node-local fs because $RUNNER_TEMP is overlayfs and
                //   can't be an overlay upperdir). Normally removed at job end,
                //   but a killed/cancelled job can orphan one — prune by age.
                if (!entry.startsWith(".temp") && !entry.startsWith(".overlay-"))
                    continue;

                const fullPath = path.join(this.cacheDir, entry);
                try {
                    const stat = await fs.stat(fullPath);
                    const ageMs = now - stat.mtimeMs;

                    if (ageMs > STALE_TEMP_FILE_AGE_MS) {
                        core.info(
                            `[NodeLocal] Removing stale ${entry.startsWith(".overlay-") ? "overlay" : "temp"} entry (${Math.floor(ageMs / 3600000)}h old): ${entry}`
                        );
                        await this.removeSafe(fullPath);
                        cleaned++;
                    }
                } catch {
                    // stat failed — file may have been cleaned by another runner
                }
            }

            if (cleaned > 0) {
                core.info(`[NodeLocal] Cleaned ${cleaned} stale temp file(s)`);
            }
        } catch (error) {
            // Cache dir may not exist yet — that's fine
            core.debug(`[NodeLocal] Cleanup skipped: ${error instanceof Error ? error.message : error}`);
        }

        return cleaned;
    }

    /**
     * Sanitize cache key to be safe as a filename.
     * Replaces path separators and special characters with hyphens.
     */
    private sanitizeKey(key: string): string {
        return key.replace(/[/\\:*?"<>|]/g, "-");
    }

    /**
     * Find the closest matching cache image in the node-local dir.
     * Scans for files matching any of the restore-key prefixes and returns the
     * most recently modified one (newest = most likely to be closest to current state).
     *
     * Returns the full path to the closest match, or null if none found.
     */
    async findClosestMatch(restoreKeys: string[]): Promise<string | null> {
        if (!this.enabled || restoreKeys.length === 0) return null;

        try {
            const entries = await fs.readdir(this.cacheDir);
            const sanitizedPrefixes = restoreKeys.map(k => this.sanitizeKey(k));

            // Find all files matching any restore-key prefix (non-temp files only)
            const candidates: { path: string; mtime: number }[] = [];
            for (const entry of entries) {
                if (entry.startsWith(".temp")) continue;
                if (!entry.endsWith(this.extension)) continue;

                const baseName = entry.slice(0, -this.extension.length);
                const matchesPrefix = sanitizedPrefixes.some(prefix =>
                    baseName.startsWith(prefix)
                );

                if (matchesPrefix) {
                    const fullPath = path.join(this.cacheDir, entry);
                    try {
                        const stat = await fs.stat(fullPath);
                        candidates.push({ path: fullPath, mtime: stat.mtimeMs });
                    } catch {
                        // File may have been removed by another runner
                    }
                }
            }

            if (candidates.length === 0) {
                core.debug("[NodeLocal] No partial match found for restore-keys");
                return null;
            }

            // Return the most recently modified match (newest = closest to current)
            candidates.sort((a, b) => b.mtime - a.mtime);
            core.info(
                `[NodeLocal] Partial match found: ${path.basename(candidates[0].path)} ` +
                `(${candidates.length} candidate(s), using newest)`
            );
            return candidates[0].path;
        } catch (error) {
            core.debug(
                `[NodeLocal] findClosestMatch failed: ${error instanceof Error ? error.message : error}`
            );
            return null;
        }
    }

    /**
     * Safely remove a file, ignoring ENOENT.
     */
    private async removeSafe(filePath: string): Promise<void> {
        try {
            // rm handles both files (.temp*) and directories (.overlay-*
            // upper/work trees) — fs.unlink would throw EISDIR on a dir.
            await fs.rm(filePath, { recursive: true, force: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                core.debug(`[NodeLocal] Failed to remove ${filePath}: ${error}`);
            }
        }
    }
}
