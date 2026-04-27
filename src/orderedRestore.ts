/**
 * orderedRestore — try a list of cache keys in order (first hit wins).
 *
 * Accepts an explicit key list via the `cache-keys` input.
 *
 * Git-aware key generation (walking history with sha256sum) has been
 * moved to the consumer workflow (D). The cache action should not know
 * about git — it only knows about cache keys and S3.
 */
import * as core from "@actions/core";
import * as custom from "./custom/cache";
import * as utils from "./utils/actionUtils";
import { Inputs } from "./constants";
import { StateProvider } from "./stateProvider";

const canSaveToS3 = process.env["RUNS_ON_S3_BUCKET_CACHE"] !== undefined;

async function run(): Promise<void> {
    try {
        if (!canSaveToS3) {
            core.setFailed(
                "Ordered cache restore requires S3 bucket configuration (RUNS_ON_S3_BUCKET_CACHE)"
            );
            return;
        }

        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: true
        });
        const customCompression = core.getInput(Inputs.CustomCompression);
        const customCompressionLevel = core.getInput(
            Inputs.CustomCompressionLevel
        );

        const cacheKeysInput = core.getInput("cache-keys");
        if (!cacheKeysInput) {
            core.setFailed(
                "'cache-keys' input is required. " +
                "Git hash-walk has been moved to the consumer workflow — " +
                "compute keys there and pass them as an explicit list."
            );
            return;
        }

        const cacheKeys = cacheKeysInput
            .split("\n")
            .map(k => k.trim())
            .filter(k => k.length > 0);

        if (cacheKeys.length === 0) {
            core.setFailed("cache-keys provided but empty after parsing");
            return;
        }

        core.info(`Trying ${cacheKeys.length} cache keys in order:`);
        cacheKeys.forEach((key, i) => {
            core.info(`  ${i + 1}. ${key}`);
        });

        // First key is the "exact" key, rest are fallbacks
        const primaryKey = cacheKeys[0];
        const restoreKeys = cacheKeys.slice(1);

        const cacheKey = await custom.restoreCache(
            cachePaths,
            primaryKey,
            restoreKeys,
            { lookupOnly: false },
            false,
            customCompression,
            customCompressionLevel
        );

        // Store primary key for save step
        const stateProvider = new StateProvider();
        stateProvider.setState("CACHE_KEY", primaryKey);

        if (!cacheKey) {
            core.info("No cache found for any of the provided keys");
            core.setOutput("matched-key", "");
            core.setOutput("cache-hit-type", "miss");
            core.setOutput("cache-hit", "false");
            return;
        }

        const isExact = cacheKey === primaryKey;
        const hitType = isExact ? "exact" : "partial";

        core.info(`Cache restored from key: ${cacheKey} (${hitType} hit)`);
        core.setOutput("matched-key", cacheKey);
        core.setOutput("cache-hit-type", hitType);
        core.setOutput("cache-hit", "true");
    } catch (error) {
        core.warning(
            `Cache restore failed: ${(error as Error).message}`
        );
        core.setOutput("matched-key", "");
        core.setOutput("cache-hit-type", "miss");
        core.setOutput("cache-hit", "false");
    }

    process.exit(0);
}

run();
