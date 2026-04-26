import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import {
    createTar,
    extractTar,
    listTar
} from "@actions/cache/lib/internal/tar";
import * as core from "@actions/core";
import { execSync } from "child_process";
import { dirname } from "path";

import { Container, ContainerOptions } from "./Container";
import { NodeLocalCache } from "./NodeLocalCache";

export class TarLz4Container extends Container {
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
            ".tar.lz4"
        );
    }

    async initialize(): Promise<void> {
        try {
            await this.nodeLocal.cleanupStaleTempFiles();
        } catch (e) {
            core.warning(`[TarLz4] Stale temp cleanup failed (non-fatal): ${(e as Error).message}`);
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
            // Point containerFile to the node-local archive and restore from it
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

    protected getLogPrefix(): string {
        return "[TAR-LZ4]";
    }

    isSupportedMethod(method: string): boolean {
        return method === "lz4";
    }

    async restore(): Promise<void> {
        try {
            if (this.compressionMethod && process.platform !== "win32") {
                const compressionArgs =
                    this.compressionMethod === "none"
                        ? ""
                        : `--use-compress-program=${this.compressionMethod}`;
                const command = `tar -xf ${this.containerFile} -P -C ${this.baseDir} ${compressionArgs}`;
                this.logInfo(
                    `Extracting ${this.containerFile} to ${this.baseDir}`
                );
                const output = execSync(command);
                if (output && output.length > 0) {
                    this.logInfo(output.toString());
                }
            } else if (this.compressionMethod && process.platform === "win32") {
                const tarPath = "tar";

                const lz4Path = "lz4.exe";

                // Build the arguments array
                const args: string[] = [];

                args.push("--force-local");
                args.push("--posix");

                if (this.compressionMethod !== "none") {
                    args.push(`--use-compress-program="${lz4Path}"`);
                }

                // Properly quote and convert paths
                args.push("-xf", `"${this.toTarPath(this.containerFile)}"`);
                args.push("-P");
                args.push("-C", `"${this.toTarPath(this.baseDir)}"`);

                // Combine all arguments into the command
                const command = `"${tarPath}" ${args.join(" ")}`;

                this.logDebug(`Executing command: ${command}`);

                const output = execSync(command, { stdio: "inherit" });
                if (output && output.length > 0) {
                    this.logDebug(output.toString());
                }
            } else {
                return extractTar(
                    this.containerFile,
                    this.compressionMethod as CompressionMethod
                );
            }
        } catch (error) {
            throw this.wrapError("restore TAR-LZ4 cache", error);
        }
    }

    async save(): Promise<void> {
        try {
            if (this.compressionMethod && process.platform !== "win32") {
                this.logDebug(`Creating archive: ${this.containerFile}`);
                const compressionArgs =
                    this.compressionMethod === "none"
                        ? ""
                        : `--use-compress-program=${this.compressionMethod}`;
                const command = `tar --posix -cf ${
                    this.containerFile
                } --exclude ${this.containerFile} -P -C ${
                    this.baseDir
                } ${this.pathsToCache.join(" ")} ${compressionArgs}`;
                const output = execSync(command);
                if (output && output.length > 0) {
                    this.logDebug(output.toString());
                }
            } else if (this.compressionMethod && process.platform === "win32") {
                this.logDebug(`Creating archive: ${this.containerFile}`);
                const tarPath = "tar";

                // Use 'lz4' directly, assuming it's in the PATH
                const lz4Path = "lz4.exe";

                // Build the arguments array
                const args: string[] = [];

                args.push("--posix");
                args.push("--force-local");

                if (this.compressionMethod !== "none") {
                    args.push(`--use-compress-program="${lz4Path}"`);
                }

                // Properly quote and convert path
                args.push("-cf", `"${this.toTarPath(this.containerFile)}"`);
                args.push(
                    "--exclude",
                    `"${this.toTarPath(this.containerFile)}"`
                );
                args.push("-P");
                args.push("-C", `"${this.toTarPath(this.baseDir)}"`);

                // Properly quote and convert cache paths
                const quotedCachePaths = this.pathsToCache.map(
                    p => `"${this.toTarPath(p)}"`
                );

                // Combine all arguments into the command
                const command = `"${tarPath}" ${args.join(
                    " "
                )} ${quotedCachePaths.join(" ")}`;

                this.logInfo(`Executing command: ${command}`);

                const output2 = execSync(command, { stdio: "inherit" });
                if (output2 && output2.length > 0) {
                    this.logDebug(output2.toString());
                }
            } else {
                this.logDebug(`Creating archive: ${this.containerFile}`);
                await createTar(
                    dirname(this.containerFile),
                    this.pathsToCache,
                    this.compressionMethod as CompressionMethod
                );
                if (core.isDebug()) {
                    await listTar(
                        this.containerFile,
                        this.compressionMethod as CompressionMethod
                    );
                }
            }
        } catch (error) {
            throw this.wrapError("save TAR-LZ4 cache", error);
        }
    }

    private toTarPath(p: string) {
        return p.replace(/\\/g, "/");
    }
}
