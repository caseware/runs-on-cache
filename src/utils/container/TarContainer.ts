import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import { extractTar } from "@actions/cache/lib/internal/tar";

import * as core from "@actions/core";

import { Container, ContainerOptions } from "./Container";

export class TarContainer extends Container {
    requiresCreateEmptyCache = false;
    requiresKeepArchive = false;

    protected nodeLocalExtension(): string {
        return ".tar";
    }

    async initialize(): Promise<void> {
        try {
            await this.nodeLocal.cleanupStaleTempFiles();
        } catch (e) {
            core.warning(`[Tar] Stale temp cleanup failed (non-fatal): ${(e as Error).message}`);
        }
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
        } catch (error) {
            throw this.wrapError("save TAR cache", error);
        }
    }
}
