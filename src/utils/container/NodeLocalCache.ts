import * as core from "@actions/core";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

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
        return path.join(
            this.cacheDir,
            `${this.sanitizeKey(this.cacheKey)}${this.extension}`
        );
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
                await fs.access(
                    this.cacheDir,
                    (
                        await import("fs")
                    ).constants.W_OK
                );
            } catch {
                // mkdir or access failed — try with sudo (runners have privileged: true)
                const { exec: execCmd } = await import("@actions/exec");
                await execCmd("sudo", ["mkdir", "-p", this.cacheDir], {
                    silent: true
                });
                // getuid/getgid are typed optional (undefined on Windows) under
                // @types/node 24; this path is Linux-runner-only, so assert.
                await execCmd(
                    "sudo",
                    [
                        "chown",
                        `${process.getuid!()}:${process.getgid!()}`,
                        this.cacheDir
                    ],
                    { silent: true }
                );
                await fs.access(
                    this.cacheDir,
                    (
                        await import("fs")
                    ).constants.W_OK
                );
            }

            const randomSuffix = crypto.randomBytes(8).toString("hex");
            // Embed the sanitized cache key so the temp file is ATTRIBUTABLE to
            // this key. The coalesce liveness check (populateIsDead) keys off an
            // active temp file's mtime; with multiple distinct keys populating
            // concurrently on the same node (e.g. aarch64 + x86_64, or across a
            // yarn.lock/base-fp change), a keyless `.tempXXX` name would make one
            // key's download look like liveness for a DIFFERENT key's lock. The
            // `.temp-<key>-<rand>` form lets the check match only this key's temp.
            const tempPath = path.join(
                this.cacheDir,
                `.temp-${this.sanitizeKey(this.cacheKey)}-${randomSuffix}${
                    this.extension
                }`
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
                core.info(
                    `[NodeLocal] Another runner already populated ${finalPath} — skipping`
                );
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
                core.info(
                    `[NodeLocal] Race detected on commit — another runner won. Cleaning up.`
                );
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
     * In-flight COALESCE for node-local population.
     *
     * Problem: when a key is cold node-local (e.g. right after a key rotation, or
     * on a fresh node), EVERY runner that lands on the node AND the prewarm
     * DaemonSet all race to download (~5 GB) + decompress (~25 GB) the SAME image
     * simultaneously. Only one wins the final atomic rename; the rest throw away
     * minutes of identical work ("Another runner already committed — using
     * existing"). Deploying the prewarm DS made this near-certain.
     *
     * Fix: a per-key lock (atomic `mkdir <key>.lock.d`, which is atomic even on a
     * shared hostPath). The first caller acquires it and populates; concurrent
     * callers WAIT for the final image to appear and reuse it — skipping the
     * redundant download+decompress entirely.
     *
     * Returns:
     *   "hit"      — the final image appeared while we waited; caller should mount it (no work).
     *   "populate" — we hold the lock; caller does the download+decompress+commit,
     *                then MUST call releasePopulateLock().
     *
     * Liveness WITHOUT a heartbeat process (this is the crux). The GitHub Actions
     * runner executes the restore action as a short-lived node process that EXITS
     * between composite steps — an in-process setInterval heartbeat dies with it,
     * so the lock's freshness must be observable from the FILESYSTEM alone. It is:
     * the populator downloads into a `.temp<ext>` file that the kernel keeps
     * writing (mtime advances) for the whole ~1-5 min download+decompress, with NO
     * surviving process required. So:
     *   - lock present + an active `.temp<ext>` (mtime advanced < STALE_LOCK_MS
     *     ago)  ⇒ a populate is genuinely in flight ⇒ WAIT.
     *   - lock present + NO fresh temp file (none, or mtime stale)  ⇒ the producer
     *     died (or hasn't started writing within GRACE_MS) ⇒ STEAL atomically.
     *   - final image present ⇒ "hit".
     *
     * Steal is atomic via rename(lockDir → lockDir.dead-<uniq>): only one waiter's
     * rename of a given source can succeed, so no thundering-herd double-steal;
     * losers get ENOENT and re-race for the fresh lock. Waiter self-populates after
     * WAIT_TIMEOUT_MS (never deadlock).
     */
    private get lockDir(): string {
        return path.join(
            this.cacheDir,
            `${this.sanitizeKey(this.cacheKey)}.lock.d`
        );
    }

    // A populate = download (~1 min) + decompress (~5 min). Liveness is proven by
    // the .temp file's mtime advancing; we tolerate STALE_LOCK_MS of no-growth
    // before declaring the producer dead. GRACE_MS gives a just-acquired lock time
    // to create its temp file before any waiter can judge it stale.
    private static readonly STALE_LOCK_MS = 60_000; // no temp-file growth for 60s ⇒ dead
    private static readonly GRACE_MS = 45_000; // new lock's head-start to start writing
    private static readonly WAIT_TIMEOUT_MS = 12 * 60_000; // waiter ceiling → self-populate

    async acquirePopulateLockOrWait(): Promise<"hit" | "populate"> {
        if (!this.enabled) return "populate";
        const POLL_MS = 3000;
        const started = Date.now();

        if (await this.exists()) return "hit";

        while (Date.now() - started <= NodeLocalCache.WAIT_TIMEOUT_MS) {
            // Acquire: mkdir is atomic; EEXIST ⇒ someone else holds it.
            try {
                await fs.mkdir(this.lockDir);
                core.info(
                    `[NodeLocal] Acquired populate lock for ${this.sanitizeKey(
                        this.cacheKey
                    )} — populating`
                );
                return "populate";
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
                    core.debug(
                        `[NodeLocal] Lock mkdir failed (${
                            (e as Error).message
                        }); populating without coalesce`
                    );
                    return "populate";
                }
            }

            // Held by another populator. If the image landed, reuse it.
            if (await this.exists()) {
                core.info(
                    `[NodeLocal] Coalesced: another populator finished ${this.sanitizeKey(
                        this.cacheKey
                    )} — reusing (skipped redundant download+decompress)`
                );
                return "hit";
            }

            // Is a populate genuinely in flight? Proven by an active temp file
            // (filesystem-observable, no heartbeat process needed).
            if (!(await this.populateIsDead())) {
                await new Promise(r => setTimeout(r, POLL_MS));
                continue;
            }

            // Dead producer — steal ATOMICALLY via rename (single winner).
            const graveyard = `${this.lockDir}.dead-${crypto
                .randomBytes(6)
                .toString("hex")}`;
            try {
                await fs.rename(this.lockDir, graveyard);
                core.warning(
                    `[NodeLocal] Populate lock has no active download for >${
                        NodeLocalCache.STALE_LOCK_MS / 1000
                    }s — stealing it atomically (producer died)`
                );
                await this.removeSafe(graveyard);
                continue; // we won the steal; retry mkdir
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") {
                    // Another waiter stole it first — re-race for the fresh lock.
                    continue;
                }
                // Unexpected — fall through to poll/timeout.
                await new Promise(r => setTimeout(r, POLL_MS));
            }
        }

        // Waited past the ceiling without a result — self-populate rather than
        // wait forever (worst case = one redundant populate, never a deadlock).
        core.warning(
            `[NodeLocal] Waited ${
                NodeLocalCache.WAIT_TIMEOUT_MS / 60000
            }m for another populator without result — populating ourselves`
        );
        return "populate";
    }

    /**
     * Decide whether the lock's owner is DEAD, using only the filesystem (no live
     * process). Alive ⇔ (a) the lock is younger than GRACE_MS (just acquired, temp
     * file may not exist yet), OR (b) there is a `.temp<ext>` file whose mtime
     * advanced within STALE_LOCK_MS (an active download is writing it). Otherwise
     * dead (crashed producer / abandoned lock).
     */
    private async populateIsDead(): Promise<boolean> {
        // (a) grace window for a freshly-acquired lock.
        try {
            const lst = await fs.stat(this.lockDir);
            if (Date.now() - lst.mtimeMs < NodeLocalCache.GRACE_MS)
                return false;
        } catch {
            return false; // lock vanished — not dead, just released
        }
        // (b) newest THIS-KEY temp mtime = download liveness. Only temps for our
        // own key count — a different key's active download must not read as
        // liveness for this lock (the multi-hash gap). Temp names are
        // `.temp-<sanitizedKey>-<rand><ext>` (+ a transient `.raw` during
        // decompress), so we match on our key prefix.
        const tempPrefix = `.temp-${this.sanitizeKey(this.cacheKey)}-`;
        try {
            const entries = await fs.readdir(this.cacheDir);
            let newestTempMtime = 0;
            for (const e of entries) {
                if (!e.startsWith(tempPrefix)) continue;
                try {
                    const st = await fs.stat(path.join(this.cacheDir, e));
                    if (st.mtimeMs > newestTempMtime)
                        newestTempMtime = st.mtimeMs;
                } catch {
                    /* raced away */
                }
            }
            if (newestTempMtime === 0) return true; // no active download for THIS key → dead
            return Date.now() - newestTempMtime > NodeLocalCache.STALE_LOCK_MS;
        } catch {
            return true; // can't inspect → assume dead so we don't wait forever
        }
    }

    async releasePopulateLock(): Promise<void> {
        if (!this.enabled) return;
        await this.removeSafe(this.lockDir);
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
                // *.lock.d / *.lock.d.dead-* → populate-coalesce locks. A lock is
                //   only live for the minutes of a populate, so any lock older
                //   than the temp-file grace ceiling is abandoned (crashed
                //   producer whose process never released it) — sweep it so it
                //   can't wedge coalesce. Uses a much shorter age than temps.
                const isLock =
                    entry.endsWith(".lock.d") ||
                    entry.includes(".lock.d.dead-");
                if (
                    !entry.startsWith(".temp") &&
                    !entry.startsWith(".overlay-") &&
                    !isLock
                )
                    continue;

                const fullPath = path.join(this.cacheDir, entry);
                try {
                    const stat = await fs.stat(fullPath);
                    const ageMs = now - stat.mtimeMs;
                    const maxAge = isLock
                        ? 30 * 60 * 1000 // locks: 30 min (well past any real populate)
                        : STALE_TEMP_FILE_AGE_MS;

                    if (ageMs > maxAge) {
                        core.info(
                            `[NodeLocal] Removing stale ${
                                entry.startsWith(".overlay-")
                                    ? "overlay"
                                    : "temp"
                            } entry (${Math.floor(
                                ageMs / 3600000
                            )}h old): ${entry}`
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
            core.debug(
                `[NodeLocal] Cleanup skipped: ${
                    error instanceof Error ? error.message : error
                }`
            );
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
                        candidates.push({
                            path: fullPath,
                            mtime: stat.mtimeMs
                        });
                    } catch {
                        // File may have been removed by another runner
                    }
                }
            }

            if (candidates.length === 0) {
                core.debug(
                    "[NodeLocal] No partial match found for restore-keys"
                );
                return null;
            }

            // Return the most recently modified match (newest = closest to current)
            candidates.sort((a, b) => b.mtime - a.mtime);
            core.info(
                `[NodeLocal] Partial match found: ${path.basename(
                    candidates[0].path
                )} ` + `(${candidates.length} candidate(s), using newest)`
            );
            return candidates[0].path;
        } catch (error) {
            core.debug(
                `[NodeLocal] findClosestMatch failed: ${
                    error instanceof Error ? error.message : error
                }`
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
                core.debug(
                    `[NodeLocal] Failed to remove ${filePath}: ${error}`
                );
            }
        }
    }
}
