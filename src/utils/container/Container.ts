import * as core from "@actions/core";

import { NodeLocalCache } from "./NodeLocalCache";

export interface ContainerOptions {
    fsSize?: string;
    bufferMb?: number;
    saveCompressionLevel?: string;
    nodeLocalCacheDir?: string;
    mountMode?: "ro" | "rw";
    /**
     * Human size (e.g. "4G") of the DEDICATED per-job ext4 loop image that
     * backs a consumer overlay's RW upper. fallocate-FULL to this size up
     * front so copy-up writes never trigger host-fs allocation on the hot path;
     * unmount + delete the one backing file frees all upper inodes at teardown
     * (O(1)). Undefined/empty => plain-dir upper fallback (slower teardown).
     * Callers should pass a fraction of the runner's ephemeral-storage.
     */
    overlayUpperSize?: string;
}

export abstract class Container {
    /**
     * Node-local cache instance — shared across all container types (E).
     * Subclasses that need it set nodeLocalExtension in their constructor;
     * the base class creates the NodeLocalCache from options.
     */
    protected readonly nodeLocal: NodeLocalCache;
    protected restoredFromNodeLocal = false;
    /**
     * Precise provenance of the restore, for metrics:
     *   "prewarmed" | "node-local" | "s3" | "cold-boot" | undefined (not set).
     * Node-local restore paths set "prewarmed" vs "node-local" based on the
     * cache-warmer prewarm stamp; the S3 / cold-boot paths are set by cache.ts.
     */
    protected restoreSource: string | undefined;
    /**
     * The cache key that was ACTUALLY restored from node-local storage.
     *
     * Equals the primary `cacheKey` on an exact node-local hit. On a PARTIAL
     * (restore-key prefix) hit it is the key of the FOREIGN image that got
     * mounted — `findClosestMatch` matches on the restore-key prefix, so the
     * image can belong to any key sharing that prefix.
     *
     * cache.ts reports this instead of blindly returning the primary key, so
     * `isExactKeyMatch` — and therefore the `cache-hit` output — describes what
     * was really restored. Returning the primary key for a partial match made
     * `cache-hit` claim an exact match for a foreign image.
     */
    protected restoredKey: string | undefined;

    /** Precise restore provenance for metrics (see restoreSource). */
    getRestoreSource(): string | undefined {
        return this.restoreSource;
    }

    /** The cache key actually restored from node-local (see restoredKey). */
    getRestoredKey(): string | undefined {
        return this.restoredKey;
    }

    constructor(
        protected containerFile: string,
        protected readonly compressionMethod: string,
        protected readonly compressionLevel: string | undefined,
        protected readonly baseDir: string,
        protected readonly pathsToCache: string[],
        protected readonly cacheKey: string,
        protected readonly options: ContainerOptions = {}
    ) {
        // Subclasses override nodeLocalExtension() before calling super()
        // isn't possible, so we provide a default. Subclasses that need
        // a different extension can re-create nodeLocal in their constructor.
        this.nodeLocal = new NodeLocalCache(
            options.nodeLocalCacheDir || "",
            cacheKey,
            this.nodeLocalExtension()
        );
    }

    abstract requiresCreateEmptyCache: boolean;
    abstract requiresKeepArchive: boolean;

    abstract isSupportedMethod(method?: string): boolean;
    abstract restore(): Promise<void>;
    abstract save(): Promise<void>;

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async initialize(): Promise<void> {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async createEmptyCache(): Promise<void> {}

    /**
     * File extension for node-local cache files.
     * Override in subclasses for different archive types.
     */
    protected nodeLocalExtension(): string {
        return ".tar";
    }

    // ── Node-local methods (E: shared implementation) ────────────────

    /**
     * Try to restore from a node-local persistent cache.
     * Default implementation: find exact/partial match, point containerFile, call restore().
     * BtrfsContainer overrides this with mount-based logic.
     */
    async tryRestoreFromNodeLocal(restoreKeys?: string[]): Promise<boolean> {
        if (!this.nodeLocal.enabled) return false;

        const localExists = await this.nodeLocal.exists();
        let localPath: string | null = localExists
            ? this.nodeLocal.localPath
            : null;
        // Exact hit restores this instance's own key; a partial hit restores
        // whichever key the matched image belongs to (see restoredKey).
        let matchedKey: string | undefined = localExists
            ? this.cacheKey
            : undefined;

        if (!localPath && restoreKeys && restoreKeys.length > 0) {
            localPath = await this.nodeLocal.findClosestMatch(restoreKeys);
            if (localPath) {
                matchedKey = this.nodeLocal.keyForImagePath(localPath);
                this.logInfo(
                    `Node-local partial hit — using ${localPath} (restored key: ${matchedKey}, requested: ${this.nodeLocal.sanitizedCacheKey})`
                );
            }
        }

        if (!localPath) return false;

        this.logInfo(`Node-local cache hit — restoring from ${localPath}`);

        try {
            this.containerFile = localPath;
            await this.restore();
            this.restoredFromNodeLocal = true;
            this.restoredKey = matchedKey;
            return true;
        } catch (error) {
            core.warning(
                `${this.getLogPrefix()} Node-local restore failed, falling back to S3: ${
                    error instanceof Error ? error.message : error
                }`
            );
            return false;
        }
    }

    shouldSkipS3Upload(): boolean {
        return this.restoredFromNodeLocal;
    }

    async getNodeLocalDownloadPath(): Promise<string | null> {
        return this.nodeLocal.getDownloadPath();
    }

    async commitNodeLocalDownload(tempPath: string): Promise<boolean> {
        return this.nodeLocal.commitTempFile(tempPath);
    }

    /**
     * In-flight coalesce: returns "hit" if another populator (runner or the
     * prewarm DaemonSet) already produced the node-local image while we waited —
     * the caller should then skip the S3 download+decompress and mount the final
     * image. Returns "populate" if we hold the lock and must do the work, then
     * call releaseNodeLocalPopulateLock() when done. See NodeLocalCache.
     */
    async coalesceNodeLocalPopulate(): Promise<"hit" | "populate"> {
        return this.nodeLocal.acquirePopulateLockOrWait();
    }

    async releaseNodeLocalPopulateLock(): Promise<void> {
        return this.nodeLocal.releasePopulateLock();
    }

    getNodeLocalFinalPath(): string | null {
        return this.nodeLocal.enabled ? this.nodeLocal.localPath : null;
    }

    isNodeLocalEnabled(): boolean {
        return this.nodeLocal.enabled;
    }

    // ── Common helpers ───────────────────────────────────────────────

    setArchivePath(archivePath: string): void {
        this.containerFile = archivePath;
    }

    protected wrapError(operation: string, error: unknown): Error {
        return new Error(
            `Failed to ${operation}: ${
                error instanceof Error ? error.message : error
            }`
        );
    }

    protected logInfo(message: string, prefix?: string): void {
        const logPrefix = prefix || this.getLogPrefix();
        core.info(`${logPrefix} ${message}`);
    }

    protected logDebug(message: string, prefix?: string): void {
        const logPrefix = prefix || this.getLogPrefix();
        core.debug(`${logPrefix} ${message}`);
    }

    protected createError(message: string, prefix?: string): Error {
        const logPrefix = prefix || this.getLogPrefix();
        return new Error(`${logPrefix} ${message}`);
    }

    protected getLogPrefix(): string {
        return "[CONTAINER]";
    }
}
