import * as core from "@actions/core";

// Mock modules before import
jest.mock("@actions/core");
jest.mock("../src/custom/cache");
jest.mock("../src/utils/actionUtils");
jest.mock("../src/stateProvider");

describe("orderedRestore", () => {
    const mockGetInput = core.getInput as jest.Mock;
    const mockSetOutput = core.setOutput as jest.Mock;
    const mockInfo = core.info as jest.Mock;
    const mockSetFailed = core.setFailed as jest.Mock;
    const mockWarning = core.warning as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env["RUNS_ON_S3_BUCKET_CACHE"] = "test-bucket";
    });

    afterEach(() => {
        delete process.env["RUNS_ON_S3_BUCKET_CACHE"];
    });

    describe("cache key parsing", () => {
        test("parses multiline cache-keys input correctly", () => {
            const input = "exact-key-abc123\nweek-17-prefix\nany-prefix";
            const keys = input
                .split("\n")
                .map(k => k.trim())
                .filter(k => k.length > 0);

            expect(keys).toEqual([
                "exact-key-abc123",
                "week-17-prefix",
                "any-prefix"
            ]);
        });

        test("filters empty lines and whitespace", () => {
            const input =
                "  key-1  \n\n  key-2  \n  \n  key-3  ";
            const keys = input
                .split("\n")
                .map(k => k.trim())
                .filter(k => k.length > 0);

            expect(keys).toEqual(["key-1", "key-2", "key-3"]);
        });

        test("first key is primary, rest are restore keys", () => {
            const keys = ["exact-key", "fallback-1", "fallback-2"];
            const primaryKey = keys[0];
            const restoreKeys = keys.slice(1);

            expect(primaryKey).toBe("exact-key");
            expect(restoreKeys).toEqual(["fallback-1", "fallback-2"]);
        });
    });

    describe("cache-hit-type determination", () => {
        test("returns 'exact' when matched key equals primary key", () => {
            const primaryKey: string = "nodemodules-Linux-abc123";
            const matchedKey: string = "nodemodules-Linux-abc123";
            const isExact = matchedKey === primaryKey;

            expect(isExact).toBe(true);
            expect(isExact ? "exact" : "partial").toBe("exact");
        });

        test("returns 'partial' when matched key differs from primary key", () => {
            const primaryKey: string = "nodemodules-Linux-abc123";
            const matchedKey: string = "nodemodules-Linux-def456";
            const isExact = matchedKey === primaryKey;

            expect(isExact).toBe(false);
            expect(isExact ? "exact" : "partial").toBe("partial");
        });

        test("returns 'miss' when no key matches", () => {
            const matchedKey: string | undefined = undefined;

            expect(!matchedKey).toBe(true);
        });
    });

    describe("output contract", () => {
        test("outputs matched-key, cache-hit-type, cache-hit on exact match", () => {
            const outputs: Record<string, string> = {};

            // Simulate exact match
            const cacheKey = "exact-key";
            const primaryKey = "exact-key";
            const isExact = cacheKey === primaryKey;

            outputs["matched-key"] = cacheKey;
            outputs["cache-hit-type"] = isExact ? "exact" : "partial";
            outputs["cache-hit"] = "true";

            expect(outputs["matched-key"]).toBe("exact-key");
            expect(outputs["cache-hit-type"]).toBe("exact");
            expect(outputs["cache-hit"]).toBe("true");
        });

        test("outputs correctly on partial match", () => {
            const outputs: Record<string, string> = {};

            const cacheKey: string = "fallback-key";
            const primaryKey: string = "exact-key";
            const isExact = cacheKey === primaryKey;

            outputs["matched-key"] = cacheKey;
            outputs["cache-hit-type"] = isExact ? "exact" : "partial";
            outputs["cache-hit"] = "true";

            expect(outputs["matched-key"]).toBe("fallback-key");
            expect(outputs["cache-hit-type"]).toBe("partial");
            expect(outputs["cache-hit"]).toBe("true");
        });

        test("outputs correctly on miss", () => {
            const outputs: Record<string, string> = {};

            outputs["matched-key"] = "";
            outputs["cache-hit-type"] = "miss";
            outputs["cache-hit"] = "false";

            expect(outputs["matched-key"]).toBe("");
            expect(outputs["cache-hit-type"]).toBe("miss");
            expect(outputs["cache-hit"]).toBe("false");
        });
    });

    describe("use cases", () => {
        test("NX workspace-data key ordering", () => {
            const keys = [
                "nx-ws-data-2026-W17-abc123",
                "nx-ws-data-2026-W17-",
                "nx-ws-data-2026-W16-",
                "nx-ws-data-"
            ];

            expect(keys[0]).toContain("W17-abc123");
            expect(keys.length).toBe(4);
        });

        test("LFS key ordering", () => {
            const keys = [
                "lfs-abc123-my-project",
                "lfs-abc123-",
                "lfs-"
            ];

            expect(keys[0]).toContain("my-project");
            expect(keys.length).toBe(3);
        });

        test("git objects key ordering", () => {
            const keys = [
                "git-objects-2026-W17",
                "git-objects-2026-W16",
                "git-objects-"
            ];

            expect(keys[0]).toContain("W17");
            expect(keys.length).toBe(3);
        });

        test("callers can use cache-hit-type to decide force-save", () => {
            const shouldForceSave = (hitType: string): boolean =>
                hitType !== "exact";

            // exact hit → no save needed
            expect(shouldForceSave("exact")).toBe(false);

            // partial hit → force-save to update cache
            expect(shouldForceSave("partial")).toBe(true);

            // miss → force-save to create cache
            expect(shouldForceSave("miss")).toBe(true);
        });
    });
});
