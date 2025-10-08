import { CompressionProvider } from "./compression/CompressionProvider";

export interface FsUtilsOptions {
    fsSize?: string;
    bufferMb?: number;
}

export abstract class FsUtils {
    protected compressionProvider: CompressionProvider;

    constructor(
        protected readonly archivePath: string,
        protected readonly baseDir: string,
        protected readonly pathsToCache: string[],
        protected readonly cacheKey: string,
        compressionProvider: CompressionProvider,
        protected readonly options: FsUtilsOptions = {}
    ) {
        this.compressionProvider = compressionProvider;
    }

    abstract initialize(): Promise<void>;
    abstract createEmptyCache(): Promise<void>;
    abstract restore(): Promise<void>;
    abstract save(): Promise<void>;

    protected getArchivePathWithExtension(): string {
        const ext = this.compressionProvider.getExtension();
        if (ext && !this.archivePath.endsWith(`.${ext}`)) {
            return `${this.archivePath}.${ext}`;
        }
        return this.archivePath;
    }
}