import * as core from "@actions/core";
import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";

const STALE_TEMP_FILE_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
const STALE_ACTIVE_FILE_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * NodeLocalCache provides node-level persistent caching via a HostPath-mounted directory.
 *
 * Architecture:
 *   /opt/local-volumes/btrfs-cache/   (HostPath mount on EKS nodes)
 *     ├── <cache-key>.btrfs           (final WORM images — 1 per cache key)
 *     ├── .pool-<key>-NN.btrfs        (prestaged copies with unique UUIDs, created by cache-warmer)
 *     ├── .active-<id>.btrfs          (in-use by a running job — acquired from pool via atomic rename)
 *     ├── <cache-key>.tar.lz4         (final tar archives)
 *     └── .temp<random>.btrfs         (in-progress population, cleaned after 12h)
 *
 * Flow:
 *   1. Check if node-local file exists for the cache key → instant mount (~1-2s)
 *   2. Try to acquire a prestaged pool copy (.pool-*) via atomic rename → .active-*
 *   3. If no pool copy, copy from WORM + UUID randomize (fallback)
 *   4. If missing entirely, download from S3 → write to .tempXXX → atomic mv → mount
 *   5. Prune stale .temp* and .active-* files older than 12 hours
 *   6. LRU eviction: if total WORM size exceeds budget, evict oldest images
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
                await execCmd("sudo", ["chown", `${process.getuid()}:${process.getgid()}`, this.cacheDir], { silent: true });
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
                if (!entry.startsWith(".temp")) continue;

                const fullPath = path.join(this.cacheDir, entry);
                try {
                    const stat = await fs.stat(fullPath);
                    const ageMs = now - stat.mtimeMs;

                    if (ageMs > STALE_TEMP_FILE_AGE_MS) {
                        core.info(
                            `[NodeLocal] Removing stale temp file (${Math.floor(ageMs / 3600000)}h old): ${entry}`
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

    // ── Pool copy acquisition ─────────────────────────────────────────

    /**
     * Try to acquire a prestaged pool copy for this cache key.
     *
     * The cache-warmer DaemonSet creates `.pool-{sanitized-key}-NN.btrfs`
     * files, each with a unique BTRFS UUID (randomized during prestage).
     * This method atomically renames the first available pool copy to
     * `.active-{unique_id}.btrfs`, making it exclusively owned by this job.
     *
     * Returns the acquired file path, or null if no pool copy is available.
     */
    async tryAcquirePoolCopy(): Promise<string | null> {
        if (!this.enabled) return null;

        const sanitizedKey = this.sanitizeKey(this.cacheKey);
        const poolPrefix = `.pool-${sanitizedKey}-`;

        try {
            const entries = await fs.readdir(this.cacheDir);
            const poolFiles = entries
                .filter(e => e.startsWith(poolPrefix) && e.endsWith(this.extension) && !e.includes("staging"))
                .sort();

            if (poolFiles.length === 0) {
                core.debug("[NodeLocal] No pool copies available");
                return null;
            }

            // Try each pool file — another job may race us for the same slot
            for (const poolFile of poolFiles) {
                const sourcePath = path.join(this.cacheDir, poolFile);
                const activeId = crypto.randomBytes(8).toString("hex");
                const activePath = path.join(
                    this.cacheDir,
                    `.active-${activeId}${this.extension}`
                );

                try {
                    await fs.rename(sourcePath, activePath);
                    core.info(
                        `[NodeLocal] Acquired pool copy: ${poolFile} → ${path.basename(activePath)}`
                    );
                    return activePath;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (code === "ENOENT") {
                        // Another job grabbed it first — try next slot
                        core.debug(`[NodeLocal] Pool copy ${poolFile} already taken, trying next`);
                        continue;
                    }
                    core.warning(
                        `[NodeLocal] Failed to acquire pool copy ${poolFile}: ${
                            error instanceof Error ? error.message : error
                        }`
                    );
                }
            }

            core.debug("[NodeLocal] All pool copies taken by other jobs");
            return null;
        } catch (error) {
            core.debug(
                `[NodeLocal] tryAcquirePoolCopy failed: ${error instanceof Error ? error.message : error}`
            );
            return null;
        }
    }

    /**
     * Create an .active-* path for a fallback copy (when no pool copy available).
     * The copy is placed in the same directory as the WORM image so that
     * `fs.rename()` from WORM to active is a same-filesystem atomic operation.
     */
    createActivePath(): string {
        const activeId = crypto.randomBytes(8).toString("hex");
        return path.join(
            this.cacheDir,
            `.active-${activeId}${this.extension}`
        );
    }

    // ── LRU eviction ────────────────────────────────────────────────

    /**
     * Evict oldest WORM images when total size exceeds the budget.
     * Called before downloading new images on cache miss.
     *
     * Skips files that are:
     *   - Pool copies (.pool-*)
     *   - Active job copies (.active-*)
     *   - Temp files (.temp*)
     *   - Currently mounted (checked via /proc/mounts)
     *
     * @param maxGb Maximum total size in GB for WORM images. 0 disables.
     */
    async evictLRU(maxGb: number): Promise<number> {
        if (!this.enabled || maxGb <= 0) return 0;

        const maxBytes = maxGb * 1024 * 1024 * 1024;
        let evicted = 0;

        try {
            const entries = await fs.readdir(this.cacheDir);
            const wormFiles: { name: string; size: number; mtimeMs: number }[] = [];

            for (const entry of entries) {
                // Skip non-WORM files
                if (entry.startsWith(".")) continue; // .pool-*, .active-*, .temp*
                if (!entry.endsWith(this.extension)) continue;

                const fullPath = path.join(this.cacheDir, entry);
                try {
                    const stat = await fs.stat(fullPath);
                    wormFiles.push({ name: entry, size: stat.size, mtimeMs: stat.mtimeMs });
                } catch {
                    // File may have been removed
                }
            }

            const totalSize = wormFiles.reduce((sum, f) => sum + f.size, 0);
            if (totalSize <= maxBytes) {
                core.debug(
                    `[NodeLocal] LRU: ${Math.ceil(totalSize / (1024 * 1024))} MB within ` +
                    `${maxGb} GB budget — no eviction needed`
                );
                return 0;
            }

            core.info(
                `[NodeLocal] LRU: ${Math.ceil(totalSize / (1024 * 1024))} MB exceeds ` +
                `${maxGb} GB budget — evicting oldest images`
            );

            // Sort oldest first
            wormFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

            // Check which files are mounted (skip those)
            const mountedFiles = await this.getMountedFiles();

            let currentSize = totalSize;
            for (const file of wormFiles) {
                if (currentSize <= maxBytes) break;

                // Never evict the current cache key's image
                const sanitizedCurrent = `${this.sanitizeKey(this.cacheKey)}${this.extension}`;
                if (file.name === sanitizedCurrent) {
                    core.debug(`[NodeLocal] LRU: skipping current key ${file.name}`);
                    continue;
                }

                const fullPath = path.join(this.cacheDir, file.name);

                // Skip mounted files
                if (mountedFiles.has(fullPath)) {
                    core.debug(`[NodeLocal] LRU: skipping mounted ${file.name}`);
                    continue;
                }

                core.info(
                    `[NodeLocal] LRU: evicting ${file.name} ` +
                    `(${Math.ceil(file.size / (1024 * 1024))} MB, ` +
                    `${Math.floor((Date.now() - file.mtimeMs) / 3600000)}h old)`
                );
                await this.removeSafe(fullPath);
                currentSize -= file.size;
                evicted++;
            }

            if (evicted > 0) {
                core.info(
                    `[NodeLocal] LRU: evicted ${evicted} image(s), ` +
                    `${Math.ceil(currentSize / (1024 * 1024))} MB remaining`
                );
            }
        } catch (error) {
            core.warning(
                `[NodeLocal] LRU eviction failed: ${error instanceof Error ? error.message : error}`
            );
        }

        return evicted;
    }

    /**
     * Clean up stale .active-* files from crashed/killed jobs.
     */
    async cleanupStaleActiveFiles(): Promise<number> {
        if (!this.enabled) return 0;

        let cleaned = 0;
        try {
            const entries = await fs.readdir(this.cacheDir);
            const now = Date.now();
            const mountedFiles = await this.getMountedFiles();

            for (const entry of entries) {
                if (!entry.startsWith(".active-")) continue;

                const fullPath = path.join(this.cacheDir, entry);

                // Skip if currently mounted
                if (mountedFiles.has(fullPath)) continue;

                try {
                    const stat = await fs.stat(fullPath);
                    const ageMs = now - stat.mtimeMs;

                    if (ageMs > STALE_ACTIVE_FILE_AGE_MS) {
                        core.info(
                            `[NodeLocal] Removing stale active file (${Math.floor(ageMs / 3600000)}h old): ${entry}`
                        );
                        await this.removeSafe(fullPath);
                        cleaned++;
                    }
                } catch {
                    // stat failed — file may have been cleaned
                }
            }

            if (cleaned > 0) {
                core.info(`[NodeLocal] Cleaned ${cleaned} stale active file(s)`);
            }
        } catch (error) {
            core.debug(`[NodeLocal] Active cleanup skipped: ${error instanceof Error ? error.message : error}`);
        }

        return cleaned;
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /**
     * Get the set of files currently mounted as loop devices.
     * Reads /proc/mounts to find BTRFS loop-backed mounts.
     */
    private async getMountedFiles(): Promise<Set<string>> {
        const mounted = new Set<string>();
        try {
            const { exec: execCmd, getExecOutput } = await import("@actions/exec");
            const result = await getExecOutput("losetup", ["-l", "-n", "-O", "BACK-FILE"], {
                silent: true,
                ignoreReturnCode: true
            });
            if (result.exitCode === 0) {
                for (const line of result.stdout.split("\n")) {
                    const trimmed = line.trim();
                    if (trimmed) mounted.add(trimmed);
                }
            }
        } catch {
            // losetup may not be available
        }
        return mounted;
    }

    /**
     * Safely remove a file, ignoring ENOENT.
     */
    private async removeSafe(filePath: string): Promise<void> {
        try {
            await fs.unlink(filePath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT") {
                core.debug(`[NodeLocal] Failed to remove ${filePath}: ${error}`);
            }
        }
    }
}
