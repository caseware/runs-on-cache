// https://github.com/actions/toolkit/blob/%40actions/cache%403.2.2/packages/cache/src/cache.ts

import * as core from "@actions/core";
import * as path from "path";
import * as utils from "@actions/cache/lib/internal/cacheUtils";
import * as cacheHttpClient from "./backend";
import {
    createTar,
    extractTar,
    listTar,
    getTarPath
} from "@actions/cache/lib/internal/tar";
import { DownloadOptions, UploadOptions } from "@actions/cache/lib/options";
import { execSync } from "child_process";
import { getCacheFileName, getCompressionMethod } from "../utils/actionUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";

export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}

export class ReserveCacheError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReserveCacheError";
        Object.setPrototypeOf(this, ReserveCacheError.prototype);
    }
}

function checkPaths(paths: string[]): void {
    if (!paths || paths.length === 0) {
        throw new ValidationError(
            `Path Validation Error: At least one directory or file path is required`
        );
    }
}

function checkKey(key: string): void {
    if (key.length > 512) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot be larger than 512 characters.`
        );
    }
    const regex = /^[^,]*$/;
    if (!regex.test(key)) {
        throw new ValidationError(
            `Key Validation Error: ${key} cannot contain commas.`
        );
    }
}

/**
 * isFeatureAvailable to check the presence of Actions cache service
 *
 * @returns boolean return true if Actions cache service feature is available, otherwise false
 */

export function isFeatureAvailable(): boolean {
    return !!process.env["ACTIONS_CACHE_URL"];
}

/**
 * Restores cache from keys
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for key
 * @param downloadOptions cache download options
 * @param enableCrossOsArchive an optional boolean enabled to restore on windows any cache created on any platform
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
    options?: DownloadOptions,
    enableCrossOsArchive = false,
    customCompression: string | undefined = "none"
): Promise<string | undefined> {
    checkPaths(paths);

    restoreKeys = restoreKeys || [];
    const keys = [primaryKey, ...restoreKeys];

    core.debug("Resolved Keys:");
    core.debug(JSON.stringify(keys));

    if (keys.length > 10) {
        throw new ValidationError(
            `Key Validation Error: Keys are limited to a maximum of 10.`
        );
    }
    for (const key of keys) {
        checkKey(key);
    }

    const compressionMethod = await getCompressionMethod(customCompression);
    let archivePath = "";
    try {
        // path are needed to compute version
        const cacheEntry = await cacheHttpClient.getCacheEntry(keys, paths, {
            compressionMethod,
            enableCrossOsArchive
        });
        if (!cacheEntry?.archiveLocation) {
            // Cache not found
            return undefined;
        }

        if (options?.lookupOnly) {
            core.info("Lookup only - skipping download");
            return cacheEntry.cacheKey;
        }

        archivePath = path.join(
            await utils.createTempDirectory(),
            getCacheFileName(compressionMethod)
        );
        core.debug(`Archive Path: ${archivePath}`);

        // Download the cache from the cache entry
        await cacheHttpClient.downloadCache(
            cacheEntry.archiveLocation,
            archivePath,
            options
        );

        if (core.isDebug()) {
            if (customCompression) {
                core.debug("ListTar unavailable with custom compression method");
            } else {
                await listTar(archivePath, compressionMethod as CompressionMethod);
            }
        }

        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.info(
            `Cache Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        );

        const baseDir = process.env["GITHUB_WORKSPACE"] || process.cwd();
        if (customCompression && process.platform !== "win32") {
            const compressionArgs = customCompression === "none" ? "" : `--use-compress-program=${customCompression}`;
            const command = `tar -xf ${archivePath} -P -C ${baseDir} ${compressionArgs}`;
            core.info(`Extracting ${archivePath} to ${baseDir}`);
            const output = execSync(command);
            if (output && output.length > 0) {
                core.info(output.toString());
            }
        } else if (customCompression && process.platform === "win32") {
            const tarPathObj = await getTarPath();
            const tarPath = tarPathObj.path; // Access the 'path' property

            const lz4Path = 'lz4.exe';

            // Build the arguments array
            let args: string[] = [];

            if (customCompression !== 'none') {
                args.push(`--use-compress-program="${lz4Path}"`);
            }

            // Properly quote and convert paths
            args.push('-xf', `"${toTarPath(archivePath)}"`);
            args.push('-P');
            args.push('-C', `"${toTarPath(baseDir)}"`);

            // Combine all arguments into the command
            const command = `"${tarPath}" ${args.join(' ')}`;

            core.debug(`Executing command: ${command}`);

            const output = execSync(command, { stdio: 'inherit' });
            if (output && output.length > 0) {
                core.debug(output.toString());
            }
        } else {
            await extractTar(archivePath, compressionMethod as CompressionMethod);
        }
        core.info("Cache restored successfully");

        return cacheEntry.cacheKey;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else {
            // Supress all non-validation cache related errors because caching should be optional
            core.warning(`Failed to restore: ${(error as Error).message}`);
        }
    } finally {
        // Try to delete the archive to save space
        try {
            await utils.unlinkFile(archivePath);
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }

    return undefined;
}

/**
 * Restores cache from primary key using s3 sync
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for key
 * @param downloadOptions cache download options
 * @param enableCrossOsArchive an optional boolean enabled to restore on windows any cache created on any platform
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCacheSync(
    paths: string[],
    primaryKey: string,
    options?: DownloadOptions,
): Promise<string | undefined> {
    checkPaths(paths);

    core.debug("Resolved Keys:");

    checkKey(primaryKey);

    try {
        // path are needed to compute version
        const cacheEntry = await cacheHttpClient.getCacheEntrySync(primaryKey, paths);
        if (!cacheEntry?.archiveLocation) {
            // Cache not found
            return undefined;
        }

        if (options?.lookupOnly) {
            core.info("Lookup only - skipping download");
            return cacheEntry.cacheKey;
        }

        // Download the cache from the cache entry
        await cacheHttpClient.downloadCacheSync(
            cacheEntry.archiveLocation,
            paths
        );

        core.info("Cache restored successfully");

        return cacheEntry.cacheKey;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else {
            // Supress all non-validation cache related errors because caching should be optional
            core.warning(`Failed to restore: ${(error as Error).message}`);
        }
    }

    return undefined;
}

function toTarPath(p: string) {
    return p.replace(/\\/g, '/');
}

/**
 * Saves a list of files with the specified key
 *
 * @param paths a list of file paths to be cached
 * @param key an explicit key for restoring the cache
 * @param enableCrossOsArchive an optional boolean enabled to save cache on windows which could be restored on any platform
 * @param options cache upload options
 * @returns number returns cacheId if the cache was saved successfully and throws an error if save fails
 */
export async function saveCache(
    paths: string[],
    key: string,
    options?: UploadOptions,
    enableCrossOsArchive = false,
    customCompression: string | undefined = "none"
): Promise<number> {
    core.info("Saving Cache via archive.");
    checkPaths(paths);
    checkKey(key);

    const compressionMethod = await getCompressionMethod(customCompression);
    let cacheId = -1;

    core.info(`${JSON.stringify(paths)}`);
    const cachePaths: string[] = await utils.resolvePaths(paths);
    core.info("Cache Paths:");
    core.info(`${JSON.stringify(cachePaths)}`);

    if (cachePaths.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
        );
    }

    const archiveFolder = await utils.createTempDirectory();
    const archivePath = path.join(
        archiveFolder,
        getCacheFileName(compressionMethod)
    );

    core.info(`Archive Path: ${archivePath}`);

    try {
        const baseDir = process.env["GITHUB_WORKSPACE"] || process.cwd();
        if (customCompression && process.platform !== "win32") {
            const compressionArgs = customCompression === "none" ? "" : `--use-compress-program=${customCompression}`;
            const command = `tar --posix -cf ${archivePath} --exclude ${archivePath} -P -C ${baseDir} ${cachePaths.join(' ')} ${compressionArgs}`;
            const output = execSync(command);
            if (output && output.length > 0) {
                core.debug(output.toString());
            }
        } else if (customCompression && process.platform === "win32") {
            core.info('Entering win path')
            const tarPathObj = await getTarPath();
            const tarPath = tarPathObj.path; // Access the 'path' property

            // Use 'lz4' directly, assuming it's in the PATH
            const lz4Path = 'lz4.exe';

            // Build the arguments array
            let args: string[] = [];

            args.push('--posix');

            if (customCompression !== 'none') {
                args.push(`--use-compress-program="${lz4Path}"`);
            }

            // Properly quote and convert path
            args.push('-cf', `"${toTarPath(archivePath)}"`);
            args.push('--exclude', `"${toTarPath(archivePath)}"`);
            args.push('-P');
            args.push('-C', `"${toTarPath(baseDir)}"`);

            // Properly quote and convert cache paths
            const quotedCachePaths = cachePaths.map(p => `"${toTarPath(p)}"`);

            // Combine all arguments into the command
            const command = `"${tarPath}" ${args.join(' ')} ${quotedCachePaths.join(' ')}`;

            core.info(`Executing command: ${command}`);

            const output = execSync(command, { stdio: 'inherit' });
            if (output && output.length > 0) {
                core.debug(output.toString());
            }
        }
        else {
            await createTar(archiveFolder, cachePaths, compressionMethod as CompressionMethod);
            if (core.isDebug()) {
                await listTar(archivePath, compressionMethod as CompressionMethod);
            }
        }
        const archiveFileSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.info(`File Size: ${archiveFileSize}`);

        await cacheHttpClient.saveCache(key, paths, archivePath, {
            compressionMethod,
            enableCrossOsArchive,
            cacheSize: archiveFileSize
        });

        // dummy cacheId, if we get there without raising, it means the cache has been saved
        cacheId = 1;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else if (typedError.name === ReserveCacheError.name) {
            core.info(`Failed to save: ${typedError.message}`);
        } else {
            core.warning(`Failed to save: ${typedError.message}`);
        }
    } finally {
        // Try to delete the archive to save space
        try {
            await utils.unlinkFile(archivePath);
        } catch (error) {
            core.debug(`Failed to delete archive: ${error}`);
        }
    }

    return cacheId;
}

/**
 * Saves a list of files with the specified key
 *
 * @param paths a list of file paths to be cached
 * @param key an explicit key for restoring the cache
 * @returns number returns cacheId if the cache was saved successfully and throws an error if save fails
 */
export async function saveCacheSync(
    paths: string[],
    key: string
): Promise<number> {
    core.info("Saving Cache via sync.");
    checkPaths(paths);
    checkKey(key);

    let cacheId = -1;

    const cachePaths = await utils.resolvePaths(paths);
    core.debug("Cache Paths:");
    core.debug(`${JSON.stringify(cachePaths)}`);

    if (cachePaths.length === 0) {
        throw new Error(
            `Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.`
        );
    }

    try {
        await cacheHttpClient.saveCacheSync(key, paths);
        // dummy cacheId, if we get there without raising, it means the cache has been saved
        cacheId = 1;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else if (typedError.name === ReserveCacheError.name) {
            core.info(`Failed to save: ${typedError.message}`);
        } else {
            core.warning(`Failed to save: ${typedError.message}`);
        }
    }
    return cacheId;
}
