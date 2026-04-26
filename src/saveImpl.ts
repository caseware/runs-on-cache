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
import { execSync } from "child_process";
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
        process.exit(0);
    }
}

export async function saveRun(earlyExit?: boolean | undefined): Promise<void> {
    try {
        // Only attempt save if the restore step completed successfully.
        // The main step sets CACHE_SAVE_ENABLED on successful restore.
        // With post-if: "always()", the post step runs on success, failure,
        // AND cancellation — but we skip the S3 upload when restore didn't
        // complete. BTRFS cleanup always runs in the finally block below.
        const saveEnabled = core.getState("CACHE_SAVE_ENABLED") === "true";
        if (saveEnabled) {
            await saveImpl(new StateProvider());
        } else {
            core.info("Skipping cache save — restore step did not complete successfully");
        }
    } catch (err) {
        console.error(err);
    } finally {
        // Always clean up BTRFS mounts, even if save was skipped or failed.
        // Prevents stale mounts from causing EBUSY in downstream cleanup.
        await btrfsCleanup();
    }

    // node will stay alive if any promises are not resolved,
    // which is a possibility if HTTP requests are dangling
    // due to retries or timeouts. We know that if we got here
    // that all promises that we care about have successfully
    // resolved, so simply exit with success.
    if (earlyExit) {
        process.exit(0);
    }
}

/**
 * Clean up any active BTRFS mounts and loop devices.
 * Idempotent — safe to call even if no BTRFS mounts exist.
 */
async function btrfsCleanup(): Promise<void> {
    if (process.platform !== "linux") return;

    try {
        // Find all BTRFS mounts
        const output = execSync("findmnt -t btrfs -n -o TARGET", {
            encoding: "utf8",
            timeout: 10000
        }).trim();
        if (!output) return;

        // Unmount in reverse order (bind mounts before main mounts)
        const mounts = output
            .split("\n")
            .map(m => m.trim())
            .filter(m => m.length > 0)
            .reverse();

        for (const mount of mounts) {
            try {
                core.info(`[BTRFS cleanup] Unmounting: ${mount}`);
                execSync(`sudo umount "${mount}"`, {
                    encoding: "utf8",
                    timeout: 30000
                });
            } catch {
                // Fallback to lazy unmount
                try {
                    execSync(`sudo umount -l "${mount}"`, {
                        encoding: "utf8",
                        timeout: 30000
                    });
                } catch {
                    /* already unmounted */
                }
            }
        }

        // Detach orphaned loop devices backing .btrfs files
        try {
            const losetupOutput = execSync("losetup -a", {
                encoding: "utf8",
                timeout: 10000
            }).trim();
            const loopLines = losetupOutput
                .split("\n")
                .filter(l => l.includes(".btrfs"));
            for (const line of loopLines) {
                const device = line.split(":")[0];
                if (device) {
                    core.info(
                        `[BTRFS cleanup] Detaching loop device: ${device}`
                    );
                    try {
                        execSync(`sudo losetup -d "${device}"`, {
                            encoding: "utf8",
                            timeout: 10000
                        });
                    } catch {
                        /* already detached */
                    }
                }
            }
        } catch {
            /* no loop devices or command failed */
        }
    } catch {
        // findmnt not available or no BTRFS mounts — nothing to clean
    }
}
