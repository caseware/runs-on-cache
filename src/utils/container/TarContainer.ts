import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import { extractTar } from "@actions/cache/lib/internal/tar";

import * as core from "@actions/core";

import { Container, ContainerOptions } from "./Container";
import { NodeLocalCache } from "./NodeLocalCache";

export class TarContainer extends Container {
    requiresCreateEmptyCache = false;
    requiresKeepArchive = false;

    private readonly nodeLocal: NodeLocalCache;
    private restoredFromNodeLocal = false;

    constructor(
        containerFile: string,
        compressionMethod: string,
        compressionLevel: string | undefined,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerOptions
    ) {
        super(
            containerFile,
            compressionMethod,
            compressionLevel,
            baseDir,
            pathsToCache,
            cacheKey,
            options
        );
        this.nodeLocal = new NodeLocalCache(
            options.nodeLocalCacheDir || "",
            cacheKey,
            ".tar"
        );
    }

    async initialize(): Promise<void> {
        try {
            await this.nodeLocal.cleanupStaleTempFiles();
        } catch (e) {
            core.warning(`[Tar] Stale temp cleanup failed (non-fatal): ${(e as Error).message}`);
        }
    }

    async tryRestoreFromNodeLocal(restoreKeys?: string[]): Promise<boolean> {
        if (!this.nodeLocal.enabled) return false;

        // 1. Try exact key match
        const localExists = await this.nodeLocal.exists();
        let localPath: string | null = localExists ? this.nodeLocal.localPath : null;

        // 2. Try partial match from restore-keys
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

    isNodeLocalEnabled(): boolean {
        return this.nodeLocal.enabled;
    }

    protected getLogPrefix(): string {
        return "[TAR]";
    }

    isSupportedMethod(method: string): boolean {
        return method === "tar";
    }

    async restore(): Promise<void> {
        try {
            return extractTar(
                this.containerFile,
                this.compressionMethod as CompressionMethod
            );
        } catch (error) {
            throw this.wrapError("restore TAR cache", error);
        }
    }

    async save(): Promise<void> {
        try {
            this.logDebug(`Creating TAR archive: ${this.containerFile}`);
            // TAR save implementation would go here
        } catch (error) {
            throw this.wrapError("save TAR cache", error);
        }
    }
}
