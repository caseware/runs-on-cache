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
        await this.nodeLocal.cleanupStaleTempFiles();
    }

    async tryRestoreFromNodeLocal(): Promise<boolean> {
        if (!this.nodeLocal.enabled) return false;

        const localExists = await this.nodeLocal.exists();
        if (!localExists) return false;

        const localPath = this.nodeLocal.localPath;
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

    protected getLogPrefix(): string {
        return "[TAR]";
    }

    isSupportedMethod(method: string): boolean {
        return method === "tar";
    }

    async restore(): Promise<void> {
        try {
            // Persist to node-local cache if enabled (after S3 download)
            if (this.nodeLocal.enabled && !this.restoredFromNodeLocal) {
                await this.nodeLocal.persistFromS3Download(this.containerFile);
            }

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
