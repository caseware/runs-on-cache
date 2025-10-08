import { extractTar } from "@actions/cache/lib/internal/tar";
import { Container, ContainerOptions } from "./Container";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";

export class TarContainer extends Container {
    requiresCreateEmptyCache = false;

    constructor(
        containerFile: string,
        compressionMethod: string,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerOptions
    ) {
        super(containerFile, compressionMethod, baseDir, pathsToCache, cacheKey, options);
    }

    isSupportedMethod(method: string): boolean {
        return method === "tar";
    }

    async restore(): Promise<void> {
        return extractTar(this.containerFile, this.compressionMethod as CompressionMethod);        
    }

    async save(): Promise<void> {
    }
}
