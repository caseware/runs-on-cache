import { BtrfsContainer } from "./BtrfsContainer";
import { Container } from "./Container";
import { TarContainer } from "./TarContainer";
import { TarLz4Container } from "./TarLz4Container";
import { VhdxContainer } from "./VhdxContainer";

export interface ContainerFactoryOptions {
    fsSize?: string;
    bufferMb?: number;
    saveCompressionLevel?: string;
}

type Instances = {
    [K in keyof typeof SUPPORTED_CLASSES]: InstanceType<
        (typeof SUPPORTED_CLASSES)[K]
    >;
};

const SUPPORTED_CLASSES = {
    btrfs: BtrfsContainer,
    vhdx: VhdxContainer,
    tarLz4: TarLz4Container,
    tar: TarContainer
};

const DEFAULT_CLASS = "tar";

export class ContainerFactory {
    static getCacheContainer(
        customCompression: string,
        customCompressionLevel: string | undefined,
        archivePath: string,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerFactoryOptions
    ): Container {
        const instances = Object.entries(SUPPORTED_CLASSES).reduce(
            (acc, [key, Clazz]) => {
                const instance = new Clazz(
                    archivePath,
                    customCompression,
                    customCompressionLevel,
                    baseDir,
                    pathsToCache,
                    cacheKey,
                    options
                );
                return { ...acc, [key]: instance };
            },
            {} as Instances
        );

        const foundInstanceKey = (
            Object.keys(instances) as (keyof typeof instances)[]
        ).find(key => instances[key].isSupportedMethod(customCompression));

        return instances[foundInstanceKey ?? DEFAULT_CLASS];
    }
}
