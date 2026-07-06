// https://github.com/actions/toolkit/blob/%40actions/cache%403.2.2/packages/cache/src/cache.ts

import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { CompressionMethod } from "@actions/cache/lib/internal/constants";
import {
    createTar,
    extractTar,
    listTar
} from "@actions/cache/lib/internal/tar";
import { DownloadOptions, UploadOptions } from "@actions/cache/lib/options";
import * as core from "@actions/core";
import { execSync } from "child_process";
import * as path from "path";

import { Inputs, Outputs } from "../constants";
import {
    createCacheKeySpecificTempDirectory,
    getCacheFileName,
    getCompressionMethod
} from "../utils/actionUtils";
import { Container } from "../utils/container/Container";
import { ContainerFactory } from "../utils/container/ContainerFactory";
import * as cacheHttpClient from "./backend";

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
    customCompression: string | undefined = "none",
    customCompressionLevel: string | undefined = undefined
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

    core.debug(`Using compression method: ${customCompression}`);
    const compressionMethod = await getCompressionMethod(customCompression);
    core.debug(`Using compression method: ${compressionMethod}`);
    let archivePath = "";
    const fsSize = core.getInput(Inputs.FsSize) || "50G";
    core.debug(`Using fsSize: ${fsSize}`);
    const bufferMb = parseInt(core.getInput(Inputs.FsBufferMB) || "2048");
    core.debug(`Using bufferMb: ${bufferMb}`);
    const saveCompressionLevel =
        core.getInput(Inputs.SaveCompressionLevel) || undefined;
    const nodeLocalCacheDir =
        core.getInput(Inputs.NodeLocalCacheDir) ||
        process.env["NODE_LOCAL_CACHE_DIR"] ||
        "";
    const mountMode = (core.getInput(Inputs.MountMode) || "rw") as "ro" | "rw";
    const overlayUpperSize =
        core.getInput(Inputs.OverlayUpperSize) || undefined;
    let cacheContainer: Container | undefined = undefined;
    try {
        const baseDir = process.env["GITHUB_WORKSPACE"] || process.cwd();
        core.debug(`Using baseDir: ${baseDir}`);
        archivePath = path.join(
            await createCacheKeySpecificTempDirectory(primaryKey),
            getCacheFileName(compressionMethod)
        );
        core.debug(`Archive Path: ${archivePath}`);

        cacheContainer = ContainerFactory.getCacheContainer(
            customCompression,
            customCompressionLevel,
            archivePath,
            baseDir,
            paths,
            primaryKey,
            {
                fsSize,
                bufferMb,
                saveCompressionLevel,
                nodeLocalCacheDir,
                mountMode,
                overlayUpperSize
            }
        );

        // Initialize container (prerequisite checks, stale temp cleanup)
        await cacheContainer.initialize();

        // Producer / force-rebuild: never restore a (possibly stale or corrupt)
        // cached image. Skip node-local + S3 restore and build a fresh empty
        // image to populate and force-save over the key. This also self-heals a
        // poisoned cache: a corrupt image can't block its own overwrite.
        const skipRestore =
            (core.getInput(Inputs.SkipRestore) || "false") === "true";
        if (skipRestore) {
            core.info(
                "skip-restore: bypassing node-local + S3 restore — creating a fresh empty image (force-rebuild)"
            );
            core.setOutput(
                Outputs.NodeLocalCacheHit,
                cacheContainer.isNodeLocalEnabled() ? "false" : "disabled"
            );
            core.setOutput(Outputs.CacheSource, "cold-boot");
            if (cacheContainer.requiresCreateEmptyCache) {
                await cacheContainer.createEmptyCache();
            }
            return undefined;
        }

        // Try node-local restore first (fast path: ~1-2s on warm node)
        const nodeLocalEnabled = cacheContainer.isNodeLocalEnabled();
        const restoredFromLocal = await cacheContainer.tryRestoreFromNodeLocal(
            restoreKeys
        );
        if (restoredFromLocal) {
            core.info("Cache restored from node-local storage (fast path)");
            core.setOutput(Outputs.NodeLocalCacheHit, "true");
            // "prewarmed" (DaemonSet-prestaged) vs "node-local" (prior runner)
            // — set by tryRestoreFromNodeLocal based on the prewarm stamp.
            core.setOutput(
                Outputs.CacheSource,
                cacheContainer.getRestoreSource() || "node-local"
            );
            return primaryKey;
        }

        // path are needed to compute version
        const cacheEntry = await cacheHttpClient.getCacheEntry(keys, paths, {
            compressionMethod,
            enableCrossOsArchive
        });

        core.debug(`Cache Entry: ${JSON.stringify(cacheEntry)}`);
        if (!cacheEntry?.archiveLocation) {
            // Cache not found
            core.debug("Cache not found");
            core.setOutput(
                Outputs.NodeLocalCacheHit,
                nodeLocalEnabled ? "false" : "disabled"
            );
            core.setOutput(Outputs.CacheSource, "cold-boot");
            if (cacheContainer && cacheContainer.requiresCreateEmptyCache) {
                await cacheContainer.createEmptyCache();
                core.debug(
                    `Created empty cache container of type ${cacheContainer.constructor.name}`
                );
            }
            return undefined;
        }

        if (options?.lookupOnly) {
            core.info("Lookup only - skipping download");
            return cacheEntry.cacheKey;
        }

        // When node-local is enabled, download directly to the HostPath dir
        // so we avoid a redundant copy. The temp file is committed atomically after download.
        let downloadPath = archivePath;

        // IN-FLIGHT COALESCE: before spending ~5 min downloading + decompressing a
        // ~25 GB image, check whether another populator (a concurrent runner OR
        // the prewarm DaemonSet) is already producing this exact node-local key.
        // If so, wait for their result and reuse it — skipping the redundant work
        // entirely. Only the lock holder ("populate") actually downloads.
        let holdsPopulateLock = false;
        if (cacheContainer.isNodeLocalEnabled()) {
            const decision = await cacheContainer.coalesceNodeLocalPopulate();
            if (decision === "hit") {
                // Another populator produced the image while we waited. Mount it
                // via the normal node-local fast path (sets workspace + the
                // node-local-hit / cache-source outputs) instead of downloading.
                const restored = await cacheContainer.tryRestoreFromNodeLocal(
                    restoreKeys
                );
                if (restored) {
                    core.info(
                        "[NodeLocal] Coalesced onto an in-flight populate — restored from node-local (skipped redundant download+decompress)"
                    );
                    core.setOutput(Outputs.NodeLocalCacheHit, "true");
                    core.setOutput(
                        Outputs.CacheSource,
                        cacheContainer.getRestoreSource() || "node-local"
                    );
                    return cacheEntry.cacheKey;
                }
                // Mount failed (e.g. file removed under us) — fall through and populate.
                core.warning(
                    "[NodeLocal] Coalesce hit but node-local restore failed — populating ourselves"
                );
            }
            holdsPopulateLock = true; // decision === "populate"
        }

        try {
            const nodeLocalTempPath =
                await cacheContainer.getNodeLocalDownloadPath();
            if (nodeLocalTempPath) {
                downloadPath = nodeLocalTempPath;
                core.info(
                    `[NodeLocal] S3 downloading directly to node-local temp: ${downloadPath}`
                );
            }

            await cacheHttpClient.downloadCache(
                cacheEntry.archiveLocation,
                downloadPath,
                options
            );

            // If downloaded to node-local temp, commit (atomic mv) and point container at the final path
            if (nodeLocalTempPath) {
                const committed = await cacheContainer.commitNodeLocalDownload(
                    nodeLocalTempPath
                );
                if (committed) {
                    core.info(
                        `[NodeLocal] Committed download to node-local cache`
                    );
                } else {
                    core.info(
                        `[NodeLocal] Another runner already committed — using existing`
                    );
                }
                // After commit, the temp file has been renamed to the final path.
                // Use the final committed path (not the temp path which no longer exists).
                const finalPath = cacheContainer.getNodeLocalFinalPath();
                if (finalPath) {
                    downloadPath = finalPath;
                    archivePath = finalPath;
                }
            }
        } finally {
            // Release the populate lock so waiters can proceed (they mount the
            // now-final image). Best-effort; a leaked lock self-expires as stale.
            if (holdsPopulateLock) {
                await cacheContainer.releaseNodeLocalPopulateLock();
            }
        }

        if (core.isDebug()) {
            if (customCompression) {
                core.debug(
                    "ListTar unavailable with custom compression method"
                );
            } else {
                await listTar(
                    archivePath,
                    compressionMethod as CompressionMethod
                );
            }
        }

        const archiveFileSize = utils.getArchiveFileSizeInBytes(downloadPath);
        core.info(
            `Cache Size: ~${Math.round(
                archiveFileSize / (1024 * 1024)
            )} MB (${archiveFileSize} B)`
        );

        // Point the container at wherever we downloaded (node-local temp or default)
        cacheContainer.setArchivePath(downloadPath);

        await cacheContainer.restore();
        core.info("Cache restored successfully from S3");

        // Report node-local cache miss (S3 fallback) or disabled
        core.setOutput(
            Outputs.NodeLocalCacheHit,
            nodeLocalEnabled ? "false" : "disabled"
        );
        core.setOutput(Outputs.CacheSource, "s3");

        return cacheEntry.cacheKey;
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else {
            // Supress all non-validation cache related errors because caching should be optional
            core.error(`Failed to restore: ${(error as Error).message}`);

            // Distinct provenance: a cache entry WAS found/downloaded but the
            // restore/mount FAILED — this is NOT a benign miss ("cold-boot").
            // Emit "restore-failed" so downstream metrics/alerting can page on
            // this specific catastrophe (e.g. the ~7.5min "downloaded 25GB then
            // overlay mount exit 32 -> empty fallback" case) separately from an
            // expected cache miss. Also surface it as a GH Actions ::error:: so
            // the failure is loud, not a swallowed warning.
            core.setOutput(Outputs.CacheSource, "restore-failed");
            core.setOutput("restore-failed", "true");

            // Fallback: create an empty BTRFS filesystem so the workspace
            // still gets a mount and the save step can produce a new valid
            // image (e.g. after a corrupted cache download).
            if (cacheContainer && cacheContainer.requiresCreateEmptyCache) {
                try {
                    core.info(
                        "Creating empty BTRFS cache as fallback after restore failure"
                    );
                    await cacheContainer.createEmptyCache();
                } catch (createError) {
                    core.warning(
                        `Fallback createEmptyCache also failed: ${
                            (createError as Error).message
                        }`
                    );
                }
            }
        }
    } finally {
        if (!cacheContainer || !cacheContainer.requiresKeepArchive) {
            core.debug("Deleting archive to save space");
            try {
                await utils.unlinkFile(archivePath);
            } catch (error) {
                core.debug(`Failed to delete archive: ${error}`);
            }
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
    options?: DownloadOptions
): Promise<string | undefined> {
    checkPaths(paths);

    core.debug("Resolved Keys:");

    checkKey(primaryKey);

    try {
        // path are needed to compute version
        const cacheEntry = await cacheHttpClient.getCacheEntrySync(
            primaryKey,
            paths
        );
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
            // Distinct provenance (see the other restore catch above): a found
            // entry that failed to restore is NOT a benign miss — emit
            // "restore-failed" + a loud ::error:: for alerting.
            core.error(`Failed to restore: ${(error as Error).message}`);
            core.setOutput(Outputs.CacheSource, "restore-failed");
            core.setOutput("restore-failed", "true");
        }
    }

    return undefined;
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
    customCompression: string | undefined = "none",
    customCompressionLevel: string | undefined = undefined
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

    const archiveFolder = await createCacheKeySpecificTempDirectory(key);
    const archivePath = path.join(
        archiveFolder,
        getCacheFileName(compressionMethod)
    );

    core.info(`Archive Path: ${archivePath}`);
    core.info(`Archive Path2: ${archivePath}`);

    try {
        core.info(`Archive Path3: ${archivePath}`);
        const baseDir = process.env["GITHUB_WORKSPACE"] || process.cwd();

        const fsSize = core.getInput(Inputs.FsSize) || "50G";
        const bufferMb = parseInt(core.getInput(Inputs.FsBufferMB) || "2048");
        const saveCompressionLevel =
            core.getInput(Inputs.SaveCompressionLevel) || undefined;
        const nodeLocalCacheDir =
            core.getInput(Inputs.NodeLocalCacheDir) ||
            process.env["NODE_LOCAL_CACHE_DIR"] ||
            "";
        const mountMode = (core.getInput(Inputs.MountMode) || "rw") as
            | "ro"
            | "rw";
        const overlayUpperSize =
            core.getInput(Inputs.OverlayUpperSize) || undefined;
        const cacheContainer = ContainerFactory.getCacheContainer(
            customCompression,
            customCompressionLevel,
            archivePath,
            baseDir,
            paths,
            key,
            {
                fsSize,
                bufferMb,
                saveCompressionLevel,
                nodeLocalCacheDir,
                mountMode,
                overlayUpperSize
            }
        );

        await cacheContainer.initialize();
        await cacheContainer.save();

        // After save, persist to node-local if enabled (so subsequent runs on this node get a hit)
        if (
            cacheContainer.isNodeLocalEnabled() &&
            !cacheContainer.shouldSkipS3Upload()
        ) {
            const tempPath = await cacheContainer.getNodeLocalDownloadPath();
            if (tempPath) {
                try {
                    const fsModule = await import("fs/promises");
                    await fsModule.copyFile(archivePath, tempPath);
                    const committed =
                        await cacheContainer.commitNodeLocalDownload(tempPath);
                    if (committed) {
                        core.info(
                            "[NodeLocal] Saved image to node-local cache for future runs"
                        );
                    } else {
                        core.info(
                            "[NodeLocal] Node-local cache already populated by another runner"
                        );
                    }
                } catch (err) {
                    core.warning(
                        `[NodeLocal] Failed to persist to node-local: ${
                            err instanceof Error ? err.message : err
                        }`
                    );
                }
            }
        }

        // Skip S3 upload if the container was restored from node-local storage (WORM)
        if (cacheContainer.shouldSkipS3Upload()) {
            core.info(
                "Skipping S3 upload — restored from node-local cache (WORM)"
            );
            cacheId = 1;
        } else {
            const archiveFileSize =
                utils.getArchiveFileSizeInBytes(archivePath);
            core.info(`File Size: ${archiveFileSize}`);

            await cacheHttpClient.saveCache(key, paths, archivePath, {
                compressionMethod,
                enableCrossOsArchive,
                cacheSize: archiveFileSize
            });
            cacheId = 1;
        }
    } catch (error) {
        const typedError = error as Error;
        if (typedError.name === ValidationError.name) {
            throw error;
        } else if (typedError.name === ReserveCacheError.name) {
            core.info(`Failed to save: ${typedError.message}`);
        } else {
            let failOnError = false;
            try {
                failOnError = core.getBooleanInput(Inputs.FailOnSaveError, {
                    required: false
                });
            } catch {
                /* input not set */
            }
            // Post-step fallback: action inputs are not reliably present in the
            // post step, so getBooleanInput throws/defaults to false and the
            // save failure would be swallowed (job goes green). Fall back to the
            // value persisted to state during restore.
            if (
                !failOnError &&
                core.getState("FAIL_ON_SAVE_ERROR") === "true"
            ) {
                failOnError = true;
            }
            if (failOnError) {
                core.setFailed(`Cache save failed: ${typedError.message}`);
            } else {
                core.warning(`Failed to save: ${typedError.message}`);
            }
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
            let failOnError = false;
            try {
                failOnError = core.getBooleanInput(Inputs.FailOnSaveError, {
                    required: false
                });
            } catch {
                /* input not set */
            }
            // Post-step fallback: action inputs are not reliably present in the
            // post step, so getBooleanInput throws/defaults to false and the
            // save failure would be swallowed (job goes green). Fall back to the
            // value persisted to state during restore.
            if (
                !failOnError &&
                core.getState("FAIL_ON_SAVE_ERROR") === "true"
            ) {
                failOnError = true;
            }
            if (failOnError) {
                core.setFailed(`Cache save failed: ${typedError.message}`);
            } else {
                core.warning(`Failed to save: ${typedError.message}`);
            }
        }
    }
    return cacheId;
}
