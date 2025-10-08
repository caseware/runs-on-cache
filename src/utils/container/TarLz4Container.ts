import { createTar, extractTar, getTarPath, listTar } from "@actions/cache/lib/internal/tar";
import { Container, ContainerOptions } from "./Container";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import * as core from "@actions/core";
import { execSync } from "child_process";
import { dirname } from "path";

export class TarLz4Container extends Container {
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
        return method === "lz4";
    }

    async restore(): Promise<void> {
        if (this.compressionMethod && process.platform !== "win32") {
            const compressionArgs = this.compressionMethod === "none" ? "" : `--use-compress-program=${this.compressionMethod}`;
            const command = `tar -xf ${this.containerFile} -P -C ${this.baseDir} ${compressionArgs}`;
            core.info(`Extracting ${this.containerFile} to ${this.baseDir}`);
            const output = execSync(command);
            if (output && output.length > 0) {
                core.info(output.toString());
            }
        } else if (this.compressionMethod && process.platform === "win32") {
            const tarPathObj = await getTarPath();
            const tarPath = tarPathObj.path; // Access the 'path' property

            const lz4Path = 'lz4.exe';

            // Build the arguments array
            let args: string[] = [];

            args.push('--force-local');
            args.push('--posix');

            if (this.compressionMethod !== 'none') {
                args.push(`--use-compress-program="${lz4Path}"`);
            }

            // Properly quote and convert paths
            args.push('-xf', `"${this.toTarPath(this.containerFile)}"`);
            args.push('-P');
            args.push('-C', `"${this.toTarPath(this.baseDir)}"`);

            // Combine all arguments into the command
            const command = `"${tarPath}" ${args.join(' ')}`;

            core.debug(`Executing command: ${command}`);

            const output = execSync(command, { stdio: 'inherit' });
            if (output && output.length > 0) {
                core.debug(output.toString());
            }
        } else {
            return extractTar(this.containerFile, this.compressionMethod as CompressionMethod);
        }
    }

    async save(): Promise<void> {
        if (this.compressionMethod && process.platform !== "win32") {
            core.info(`Archive Path4: ${this.containerFile}`);
            const compressionArgs = this.compressionMethod === "none" ? "" : `--use-compress-program=${this.compressionMethod}`;
            const command = `tar --posix -cf ${this.containerFile} --exclude ${this.containerFile} -P -C ${this.baseDir} ${this.pathsToCache.join(' ')} ${compressionArgs}`;
            const output = execSync(command);
            if (output && output.length > 0) {
                core.debug(output.toString());
            }
        } else if (this.compressionMethod && process.platform === "win32") {
            core.info(`Archive Path5: ${this.containerFile}`);
            const tarPathObj = await getTarPath();
            const tarPath = tarPathObj.path; // Access the 'path' property

            // Use 'lz4' directly, assuming it's in the PATH
            const lz4Path = 'lz4.exe';

            // Build the arguments array
            let args: string[] = [];

            args.push('--posix');
            args.push('--force-local');

            if (this.compressionMethod !== 'none') {
                args.push(`--use-compress-program="${lz4Path}"`);
            }

            // Properly quote and convert path
            args.push('-cf', `"${this.toTarPath(this.containerFile)}"`);
            args.push('--exclude', `"${this.toTarPath(this.containerFile)}"`);
            args.push('-P');
            args.push('-C', `"${this.toTarPath(this.baseDir)}"`);

            // Properly quote and convert cache paths
            const quotedCachePaths = this.pathsToCache.map(p => `"${this.toTarPath(p)}"`);

            // Combine all arguments into the command
            const command = `"${tarPath}" ${args.join(' ')} ${quotedCachePaths.join(' ')}`;

            core.info(`Executing command: ${command}`);

            const output = execSync(command, { stdio: 'inherit' });
            if (output && output.length > 0) {
                core.debug(output.toString());
            }
        }
        else {
            core.info(`Archive Path6: ${this.containerFile}`);
            await createTar(dirname(this.containerFile), this.pathsToCache, this.compressionMethod as CompressionMethod);
            if (core.isDebug()) {
                await listTar(this.containerFile, this.compressionMethod as CompressionMethod);
            }
        }
    }

    private toTarPath(p: string) {
        return p.replace(/\\/g, '/');
    }
}
