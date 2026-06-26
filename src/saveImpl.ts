import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";

import { Events, Inputs, State } from "./constants";
import * as custom from "./custom/cache";
import {
    IStateProvider,
    NullStateProvider,
    StateProvider
} from "./stateProvider";
import * as utils from "./utils/actionUtils";
import { cleanupForCacheKey } from "./utils/container/BtrfsCleanup";
import {
    cleanupNodeLocalImage,
    CleanupPolicy
} from "./utils/container/NodeLocalCleanup";

/**
 * Marker file that workflows must create before the post step runs to
 * signal that the job completed its main work and the cache is safe to
 * upload.  Only checked for BTRFS caches — uploading a half-populated
 * BTRFS image after a cancelled job would poison the S3 cache.
 *
 * Usage in workflow YAML (add as the last step after all main work):
 *
 *   - name: Mark cache save safe
 *     if: success() || failure()
 *     run: touch "${RUNNER_TEMP}/.cache-save-ok"
 *
 * The `if: success() || failure()` condition ensures the marker is NOT
 * written when the job is cancelled.  The post step checks for this
 * file and skips the S3 upload if it's missing.
 */
const CACHE_SAVE_MARKER = ".cache-save-ok";

const canSaveToS3 = process.env["RUNS_ON_S3_BUCKET_CACHE"] !== undefined;

// Catch and log any unhandled exceptions.  These exceptions can leak out of the uploadChunk method in
// @actions/toolkit when a failed upload closes the file descriptor causing any in-process reads to
// throw an uncaught exception.  Instead of failing this action, just warn.
process.on("uncaughtException", e => utils.logWarning(e.message));

export async function saveImpl(
    stateProvider: IStateProvider
): Promise<number | void> {
    let cacheId = -1;
    try {
        if (!utils.isCacheFeatureAvailable()) {
            return;
        }

        if (!utils.isValidEvent()) {
            utils.logWarning(
                `Event Validation Error: The event type ${
                    process.env[Events.Key]
                } is not supported because it's not tied to a branch or tag ref.`
            );
            return;
        }

        // If restore has stored a primary key in state, reuse that
        // Else re-evaluate from inputs
        const primaryKey =
            stateProvider.getState(State.CachePrimaryKey) ||
            core.getInput(Inputs.Key);

        if (!primaryKey) {
            utils.logWarning(`Key is not specified.`);
            return;
        }

        // If matched restore key is same as primary key, then do not save cache
        // NO-OP in case of SaveOnly action
        const restoredKey = stateProvider.getCacheState();

        if (
            utils.isExactKeyMatch(primaryKey, restoredKey) &&
            !core.getBooleanInput(Inputs.ForceSave)
        ) {
            core.info(
                `Cache hit occurred on the primary key ${primaryKey}, not saving cache.`
            );
            return;
        }

        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: true
        });

        core.info(`Cache paths: ${cachePaths}`);

        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );

        const sync = utils.getInputAsBool(Inputs.Sync);

        const customCompression =
            core.getState("CUSTOM_COMPRESSION") ||
            core.getInput(Inputs.CustomCompression) ||
            undefined;
        const customCompressionLevel =
            core.getState("CUSTOM_COMPRESSION_LEVEL") ||
            core.getInput(Inputs.CustomCompressionLevel) ||
            undefined;

        if (canSaveToS3) {
            core.info(
                "The cache action detected a local S3 bucket cache. Using it."
            );

            if (sync) {
                cacheId = await custom.saveCacheSync(cachePaths, primaryKey);
            } else {
                cacheId = await custom.saveCache(
                    cachePaths,
                    primaryKey,
                    {
                        uploadChunkSize: utils.getInputAsInt(
                            Inputs.UploadChunkSize
                        )
                    },
                    enableCrossOsArchive,
                    customCompression,
                    customCompressionLevel
                );
            }
        } else {
            cacheId = await cache.saveCache(
                cachePaths,
                primaryKey,
                {
                    uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize)
                },
                enableCrossOsArchive
            );
        }

        if (cacheId != -1) {
            core.info(`Cache saved with key: ${primaryKey}`);
        }
    } catch (error: unknown) {
        utils.logWarning((error as Error).message);
    }
    return cacheId;
}

export async function saveOnlyRun(
    earlyExit?: boolean | undefined
): Promise<void> {
    try {
        const cacheId = await saveImpl(new NullStateProvider());
        if (cacheId === -1) {
            core.warning(`Cache save failed.`);
        }
    } catch (err) {
        console.error(err);
        if (earlyExit) {
            process.exit(1);
        }
    }

    // node will stay alive if any promises are not resolved,
    // which is a possibility if HTTP requests are dangling
    // due to retries or timeouts. We know that if we got here
    // that all promises that we care about have successfully
    // resolved, so simply exit with success.
    if (earlyExit) {
        process.exit(process.exitCode ?? 0);
    }
}

export async function saveRun(earlyExit?: boolean | undefined): Promise<void> {
    let saveSafe = false;
    try {
        // With post-if: "always()", the post step runs on success, failure,
        // AND cancellation. We skip the S3 upload when:
        //   1. Restore didn't complete (CACHE_SAVE_ENABLED not set)
        //   2. For BTRFS caches: the marker file $RUNNER_TEMP/.cache-save-ok
        //      is missing, meaning the job was cancelled or didn't complete
        //      its main work (uploading a partial BTRFS image poisons S3).
        // BTRFS cleanup always runs in the finally block regardless.
        const saveEnabled = core.getState("CACHE_SAVE_ENABLED") === "true";
        if (!saveEnabled) {
            core.info(
                "Skipping cache save — restore step did not complete successfully"
            );
        } else {
            // Image-based backends (btrfs, xfs) build a filesystem image that
            // is uploaded to S3. Uploading a half-populated image after a
            // cancelled job poisons the cache, so both are gated by the
            // .cache-save-ok marker.
            const compressionBackend = (
                core.getState("CUSTOM_COMPRESSION") ||
                core.getInput(Inputs.CustomCompression) ||
                ""
            ).split("-")[0];
            const isImageBased =
                compressionBackend === "btrfs" || compressionBackend === "xfs";

            if (isImageBased) {
                const runnerTemp = process.env["RUNNER_TEMP"] || "/tmp";
                const markerPath = path.join(runnerTemp, CACHE_SAVE_MARKER);
                if (!fs.existsSync(markerPath)) {
                    core.warning(
                        "Skipping image-based cache save — marker file " +
                            `${markerPath} not found. The job was likely ` +
                            "cancelled before completing. Add a workflow step " +
                            'to create this marker: touch "${RUNNER_TEMP}/.cache-save-ok"'
                    );
                } else {
                    await saveImpl(new StateProvider());
                    saveSafe = true;
                }
            } else {
                await saveImpl(new StateProvider());
                saveSafe = true;
            }
        }
    } catch (err) {
        console.error(err);
        // The save runs in the post step. Swallowing the error here makes the
        // step exit 0 and the job go GREEN despite a failed/poisoned save —
        // the worst outcome. When fail-on-save-error was set (persisted to
        // state during restore, since post-step inputs are unreliable), mark
        // the step failed so it exits non-zero.
        const failOnSaveError = core.getState("FAIL_ON_SAVE_ERROR") === "true";
        if (failOnSaveError) {
            core.setFailed(
                `Cache save failed: ${err instanceof Error ? err.message : err}`
            );
        }
    } finally {
        // Always clean up BTRFS mounts, even if save was skipped or failed.
        // Uses shared BtrfsCleanup (C) — scoped to this cache entry's key.
        const cacheKey =
            core.getState(State.CachePrimaryKey) || core.getInput(Inputs.Key);
        await cleanupForCacheKey(cacheKey);

        // Clean up node-local images based on the cleanup-node-local policy.
        const rawPolicy = (
            core.getInput(Inputs.CleanupNodeLocal) || "stale"
        ).toLowerCase();
        const cleanupPolicy: CleanupPolicy =
            rawPolicy === "none" || rawPolicy === "always"
                ? rawPolicy
                : "stale";
        await cleanupNodeLocalImage(cacheKey, saveSafe, cleanupPolicy);
    }

    if (earlyExit) {
        // Respect core.setFailed() which sets process.exitCode = 1.
        // Without this, process.exit(0) overrides the failure signal
        // and the job appears green despite a save error.
        process.exit(process.exitCode ?? 0);
    }
}
