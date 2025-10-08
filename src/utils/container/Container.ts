export interface ContainerOptions {
    fsSize?: string;
    bufferMb?: number;
}

export abstract class Container {
    constructor(
        protected containerFile: string,
        protected readonly compressionMethod: string,
        protected readonly baseDir: string,
        protected readonly pathsToCache: string[],
        protected readonly cacheKey: string,
        protected readonly options: ContainerOptions = {}
    ) {}
    abstract requiresCreateEmptyCache: boolean;

    abstract isSupportedMethod(method?: string): boolean;
    abstract restore(): Promise<void>;
    abstract save(): Promise<void>;

    async initialize(): Promise<void> {};
    async createEmptyCache(): Promise<void> {};
}