import * as core from "@actions/core";

export interface ContainerOptions {
    fsSize?: string;
    bufferMb?: number;
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
