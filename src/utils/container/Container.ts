import * as core from "@actions/core";
import { NodeLocalCache } from "./NodeLocalCache";

export interface ContainerOptions {
    fsSize?: string;
    bufferMb?: number;
    saveCompressionLevel?: string;
    nodeLocalCacheDir?: string;
    mountMode?: "ro" | "rw";
}

export abstract class Container {
    /**
     * Node-local cache instance — shared across all container types (E).
     * Subclasses that need it set nodeLocalExtension in their constructor;
     * the base class creates the NodeLocalCache from options.
     */
    protected readonly nodeLocal: NodeLocalCache;
    protected restoredFromNodeLocal = false;

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

        if (!localPath && restoreKeys && restoreKeys.length > 0) {
            localPath = await this.nodeLocal.findClosestMatch(restoreKeys);
            if (localPath) {
                this.logInfo(`Node-local partial hit — using ${localPath}`);
            }
        }

        if (!localPath) return false;

        this.logInfo(`Node-local cache hit — restoring from ${localPath}`);

        try {
            this.containerFile = localPath;
            await this.restore();
            this.restoredFromNodeLocal = true;
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
