import * as cache from "@actions/cache";
import * as core from "@actions/core";

import { Events, Inputs, State } from "./constants";
import {
    IStateProvider,
    NullStateProvider,
    StateProvider
} from "./stateProvider";
import * as utils from "./utils/actionUtils";

import * as custom from "./custom/cache";
import { cleanupForCacheKey } from "./utils/container/BtrfsCleanup";

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
                `Event Validation Error: The event type ${process.env[Events.Key]
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

        if (utils.isExactKeyMatch(primaryKey, restoredKey) && !core.getBooleanInput(Inputs.ForceSave)) {
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

        const customCompression = core.getState("CUSTOM_COMPRESSION") || core.getInput(Inputs.CustomCompression) || undefined;
        const customCompressionLevel = core.getState("CUSTOM_COMPRESSION_LEVEL") || core.getInput(Inputs.CustomCompressionLevel) || undefined;

        if (canSaveToS3) {
            core.info(
                "The cache action detected a local S3 bucket cache. Using it."
            );

            if (sync) {
                cacheId = await custom.saveCacheSync(
                    cachePaths,
                    primaryKey
                );
            } else {
                cacheId = await custom.saveCache(
                    cachePaths,
                    primaryKey,
                    {
                        uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize)
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
    try {
        // With post-if: "always()", the post step runs on success, failure,
        // AND cancellation. We skip the S3 upload when:
        //   1. Restore didn't complete (CACHE_SAVE_ENABLED not set)
        //   2. Job was cancelled (uploading a partial cache wastes time)
        // BTRFS cleanup always runs in the finally block regardless.

        // Debug: dump all GITHUB_* and STATE_* env vars so we can identify
        // the correct cancellation signal for JS action post steps.
        core.info("[post-step-debug] Env vars for cancellation detection:");
        for (const [key, val] of Object.entries(process.env)) {
            if (key.startsWith("GITHUB_") || key.startsWith("STATE_") || key.startsWith("RUNNER_")) {
                core.info(`  ${key}=${val}`);
            }
        }

        const cancelled =
            process.env["GITHUB_JOB_STATUS"] === "cancelled" ||
            process.env["GITHUB_ACTION_STATUS"] === "cancelled";
        if (cancelled) {
            core.info("Skipping cache save — job was cancelled");
        } else {
            const saveEnabled = core.getState("CACHE_SAVE_ENABLED") === "true";
            if (saveEnabled) {
                await saveImpl(new StateProvider());
            } else {
                core.info("Skipping cache save — restore step did not complete successfully");
            }
        }
    } catch (err) {
        console.error(err);
    } finally {
        // Always clean up BTRFS mounts, even if save was skipped or failed.
        // Uses shared BtrfsCleanup (C) — scoped to this cache entry's key.
        const cacheKey =
            core.getState(State.CachePrimaryKey) ||
            core.getInput(Inputs.Key);
        await cleanupForCacheKey(cacheKey);
    }

    if (earlyExit) {
        // Respect core.setFailed() which sets process.exitCode = 1.
        // Without this, process.exit(0) overrides the failure signal
        // and the job appears green despite a save error.
        process.exit(process.exitCode ?? 0);
    }
}
