import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import { extractTar } from "@actions/cache/lib/internal/tar";

import { Container, ContainerOptions } from "./Container";

export class TarContainer extends Container {
    requiresCreateEmptyCache = false;
    requiresKeepArchive = false;

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
