import * as core from "@actions/core";
import * as custom from "./custom/cache";
import * as utils from "./utils/actionUtils";
import { Inputs } from "./constants";
import { StateProvider } from "./stateProvider";

const canSaveToS3 = process.env["RUNS_ON_S3_BUCKET_CACHE"] !== undefined;

/**
 * Hash a file at a specific git ref using git show + sha256.
 * Returns the hex digest, or null if the file doesn't exist at that ref.
 */
async function hashFileAtRef(
    file: string,
    ref: string
): Promise<string | null> {
    try {
        const { exec: execCmd } = await import("@actions/exec");
        let stdout = "";
        const exitCode = await execCmd(
            "bash",
            [
                "-c",
                `git show ${ref}:${file} 2>/dev/null | sha256sum | cut -d' ' -f1`
            ],
            {
                silent: true,
                listeners: {
                    stdout: (data: Buffer) => {
                        stdout += data.toString();
                    }
                },
                ignoreReturnCode: true
            }
        );
        const hash = stdout.trim();
        if (exitCode !== 0 || !hash || hash.length !== 64) {
            return null;
        }
        return hash;
    } catch {
        return null;
    }
}

/**
 * Generate cache keys by walking git history.
 * For each depth level, hashes the file and yields `{prefix}-{hash}`.
 * Stops early if the file doesn't exist at a given ref.
 */
async function generateHashKeys(
    keyPrefix: string,
    hashFile: string,
    hashRef: string,
    hashDepth: number
): Promise<string[]> {
    const keys: string[] = [];
    const seenHashes = new Set<string>();

    for (let depth = 0; depth <= hashDepth; depth++) {
        const ref = depth === 0 ? hashRef : `${hashRef}~${depth}`;
        const hash = await hashFileAtRef(hashFile, ref);
        if (!hash) {
            core.debug(
                `[OrderedRestore] No file at ${ref}:${hashFile}, stopping walk at depth ${depth}`
            );
            break;
        }

        // Skip duplicate hashes (file unchanged across commits)
        if (seenHashes.has(hash)) {
            core.debug(
                `[OrderedRestore] Skipping depth ${depth} — same hash as previous`
            );
            continue;
        }
        seenHashes.add(hash);

        const key = `${keyPrefix}-${hash}`;
        keys.push(key);
        core.debug(`[OrderedRestore] depth=${depth} ref=${ref} → ${key}`);
    }

    return keys;
}

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

        // Determine mode: explicit key list or hash-walk
        const cacheKeysInput = core.getInput("cache-keys");
        const hashFile = core.getInput("hash-file");
        const keyPrefix = core.getInput("key-prefix");

        let cacheKeys: string[];

        if (cacheKeysInput) {
            // Mode 1: Explicit key list (time-based, manual ordering, etc.)
            cacheKeys = cacheKeysInput
                .split("\n")
                .map(k => k.trim())
                .filter(k => k.length > 0);

            if (cacheKeys.length === 0) {
                core.setFailed("cache-keys provided but empty after parsing");
                return;
            }

            core.info(`Mode: explicit key list (${cacheKeys.length} keys)`);
        } else if (hashFile && keyPrefix) {
            // Mode 2: Git history hash walk
            const hashRef = core.getInput("hash-ref") || "HEAD";
            const hashDepth = parseInt(
                core.getInput("hash-depth") || "20",
                10
            );

            core.info(
                `Mode: hash-walk — file=${hashFile} ref=${hashRef} depth=${hashDepth}`
            );

            cacheKeys = await generateHashKeys(
                keyPrefix,
                hashFile,
                hashRef,
                hashDepth
            );

            if (cacheKeys.length === 0) {
                core.warning(
                    `Hash walk produced no keys (file ${hashFile} not found in git history)`
                );
                core.setOutput("matched-key", "");
                core.setOutput("cache-hit-type", "miss");
                core.setOutput("cache-hit", "false");
                return;
            }
        } else {
            core.setFailed(
                "Either 'cache-keys' (explicit list) or 'hash-file' + 'key-prefix' (hash-walk) must be provided"
            );
            return;
        }

        core.info(`Trying ${cacheKeys.length} cache keys in order:`);
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
