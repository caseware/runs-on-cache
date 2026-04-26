import * as core from "@actions/core";

export interface ContainerOptions {
    fsSize?: string;
    bufferMb?: number;
    saveCompressionLevel?: string;
    nodeLocalCacheDir?: string;
    mountMode?: "ro" | "rw";
    previousVersionMount?: boolean;
}

export abstract class Container {
    constructor(
        protected containerFile: string,
        protected readonly compressionMethod: string,
        protected readonly compressionLevel: string | undefined,
        protected readonly baseDir: string,
        protected readonly pathsToCache: string[],
        protected readonly cacheKey: string,
        protected readonly options: ContainerOptions = {}
    ) {}
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
     * Try to restore from a node-local persistent cache.
     * Returns true if restored from node-local, false if S3 download is needed.
     * Default implementation returns false (no node-local support).
     */
    async tryRestoreFromNodeLocal(_restoreKeys?: string[]): Promise<boolean> {
        return false;
    }

    /**
     * Whether the S3 upload should be skipped (e.g., restored from node-local read-only).
     */
    shouldSkipS3Upload(): boolean {
        return false;
    }

    /**
     * Get the path where S3 should download the archive to.
     * When node-local caching is enabled, returns a .tempXXX path in the HostPath dir
     * so the download goes directly there (no copy).
     * Returns null when node-local is disabled (caller uses default temp dir).
     */
    async getNodeLocalDownloadPath(): Promise<string | null> {
        return null;
    }

    /**
     * Commit a node-local download: atomic mv from .tempXXX to final path.
     * Called after S3 download completes when the download went to a node-local temp path.
     * Returns true if committed, false if another runner beat us.
     */
    async commitNodeLocalDownload(tempPath: string): Promise<boolean> {
        return false;
    }

    /**
     * Whether node-local caching is enabled for this container.
     */
    isNodeLocalEnabled(): boolean {
        return false;
    }

    /**
     * Mount a previous version of the cache read-only at a secondary mount point.
     * Used for the "git alternates" pattern: the old content is available RO while
     * the new key is being populated RW.
     *
     * @param imagePath Path to the previous version's image file
     * @returns The mount point where the previous version is accessible, or null if unsupported
     */
    async mountPreviousVersion(_imagePath: string): Promise<string | null> {
        return null;
    }

    /**
     * Unmount and clean up the previous-version read-only mount (if any).
     * Called during save cleanup.
     */
    async unmountPreviousVersion(): Promise<void> {
        // Default no-op — subclasses override if they support previous-version-mount
    }

    /**
     * Update the archive file path (e.g., when S3 download goes to a different location).
     */
    setArchivePath(archivePath: string): void {
        this.containerFile = archivePath;
    }

    // Common helper methods for all container implementations
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

    // Default log prefix - subclasses can override
    protected getLogPrefix(): string {
        return "[CONTAINER]";
    }
}
