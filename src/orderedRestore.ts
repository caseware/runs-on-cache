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

        const cacheKeysInput = core.getInput("cache-keys", { required: true });
        const cacheKeys = cacheKeysInput
            .split("\n")
            .map(k => k.trim())
            .filter(k => k.length > 0);

        if (cacheKeys.length === 0) {
            core.setFailed("No cache keys provided");
            return;
        }

        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: true
        });
        const customCompression = core.getInput(Inputs.CustomCompression);
        const customCompressionLevel = core.getInput(
            Inputs.CustomCompressionLevel
        );

        core.info(
            `Trying ${cacheKeys.length} cache keys in order:`
        );
        cacheKeys.forEach((key, i) => {
            core.info(`  ${i + 1}. ${key}`);
        });

        // First key is the "exact" key, rest are fallbacks (restore-keys)
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

        // Determine if this was an exact or partial hit
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
