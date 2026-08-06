import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { NodeLocalCache } from "../src/utils/container/NodeLocalCache";

// Mock @actions/core
jest.mock("@actions/core", () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    isDebug: jest.fn(() => false),
    setFailed: jest.fn()
}));

describe("NodeLocalCache", () => {
    let tempDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nlc-test-"));
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    describe("constructor and enabled", () => {
        it("is disabled when cacheDir is empty", () => {
            const nlc = new NodeLocalCache("", "my-key", ".btrfs");
            expect(nlc.enabled).toBe(false);
        });

        it("is enabled when cacheDir is set", () => {
            const nlc = new NodeLocalCache("/some/path", "my-key", ".btrfs");
            expect(nlc.enabled).toBe(true);
        });
    });

    describe("keyForImagePath / sanitizedCacheKey", () => {
        it("derives the owning key from an image path", () => {
            const nlc = new NodeLocalCache("/opt/cache", "key-a", ".xfs");
            expect(nlc.keyForImagePath("/opt/cache/key-b.xfs")).toBe("key-b");
        });

        it("round-trips its own localPath back to its sanitized key", () => {
            const nlc = new NodeLocalCache("/opt/cache", "key-a", ".xfs");
            expect(nlc.keyForImagePath(nlc.localPath)).toBe(
                nlc.sanitizedCacheKey
            );
        });

        it("exposes the sanitized form of the primary key", () => {
            const nlc = new NodeLocalCache("/opt/cache", "a/b:c", ".xfs");
            expect(nlc.sanitizedCacheKey).toBe("a-b-c");
        });

        it("leaves a basename without the extension untouched", () => {
            const nlc = new NodeLocalCache("/opt/cache", "key-a", ".xfs");
            expect(nlc.keyForImagePath("/opt/cache/weird-name")).toBe(
                "weird-name"
            );
        });
    });

    describe("localPath", () => {
        it("constructs correct path for btrfs", () => {
            const nlc = new NodeLocalCache(
                "/opt/cache",
                "node-modules-abc123",
                ".btrfs"
            );
            expect(nlc.localPath).toBe("/opt/cache/node-modules-abc123.btrfs");
        });

        it("constructs correct path for vhdx", () => {
            const nlc = new NodeLocalCache(
                "/opt/cache",
                "my-cache-key",
                ".vhdx"
            );
            expect(nlc.localPath).toBe("/opt/cache/my-cache-key.vhdx");
        });

        it("constructs correct path for tar.lz4", () => {
            const nlc = new NodeLocalCache("/opt/cache", "my-key", ".tar.lz4");
            expect(nlc.localPath).toBe("/opt/cache/my-key.tar.lz4");
        });

        it("sanitizes keys with path separators", () => {
            const nlc = new NodeLocalCache(
                "/opt/cache",
                "my/key:with*special",
                ".btrfs"
            );
            expect(nlc.localPath).toBe("/opt/cache/my-key-with-special.btrfs");
        });
    });

    describe("exists", () => {
        it("returns false when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            expect(await nlc.exists()).toBe(false);
        });

        it("returns false when file does not exist", async () => {
            const nlc = new NodeLocalCache(tempDir, "nonexistent", ".btrfs");
            expect(await nlc.exists()).toBe(false);
        });

        it("returns true when file exists", async () => {
            const nlc = new NodeLocalCache(tempDir, "exists", ".btrfs");
            await fs.writeFile(nlc.localPath, "dummy-content");
            expect(await nlc.exists()).toBe(true);
        });
    });

    describe("createTempFile", () => {
        it("returns null when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            expect(await nlc.createTempFile()).toBeNull();
        });

        it("creates temp file path in cache dir", async () => {
            const nlc = new NodeLocalCache(tempDir, "key", ".btrfs");
            const tempPath = await nlc.createTempFile();
            expect(tempPath).not.toBeNull();
            expect(tempPath!).toMatch(/\.temp-.+-[0-9a-f]+\.btrfs$/);
            expect(path.dirname(tempPath!)).toBe(tempDir);
        });

        it("creates cache dir if missing", async () => {
            const nestedDir = path.join(tempDir, "nested", "cache");
            const nlc = new NodeLocalCache(nestedDir, "key", ".btrfs");
            const tempPath = await nlc.createTempFile();
            expect(tempPath).not.toBeNull();
            expect(tempPath!).toContain(nestedDir);
            const stat = await fs.stat(nestedDir);
            expect(stat.isDirectory()).toBe(true);
        });
    });

    describe("commitTempFile", () => {
        it("returns false when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            expect(await nlc.commitTempFile("/some/temp")).toBe(false);
        });

        it("moves temp file to final location", async () => {
            const nlc = new NodeLocalCache(tempDir, "commit-test", ".btrfs");
            const tempPath = await nlc.createTempFile();
            expect(tempPath).not.toBeNull();
            await fs.writeFile(tempPath!, "test-data");

            const won = await nlc.commitTempFile(tempPath!);
            expect(won).toBe(true);

            // Final file should exist
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("test-data");

            // Temp file should be gone
            await expect(fs.access(tempPath!)).rejects.toThrow();
        });

        it("returns false and cleans up when another runner already placed the file", async () => {
            const nlc = new NodeLocalCache(tempDir, "race-test", ".btrfs");

            // Another runner already placed the file
            await fs.writeFile(nlc.localPath, "existing-data");

            const tempPath = await nlc.createTempFile();
            expect(tempPath).not.toBeNull();
            await fs.writeFile(tempPath!, "our-data");

            const won = await nlc.commitTempFile(tempPath!);
            expect(won).toBe(false);

            // Original file should remain unchanged
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("existing-data");

            // Temp file should be cleaned up
            await expect(fs.access(tempPath!)).rejects.toThrow();
        });
    });

    describe("getDownloadPath", () => {
        it("returns null when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            expect(await nlc.getDownloadPath()).toBeNull();
        });

        it("returns a temp path in the cache dir when enabled", async () => {
            const nlc = new NodeLocalCache(tempDir, "dl-path-test", ".btrfs");
            const dlPath = await nlc.getDownloadPath();
            expect(dlPath).not.toBeNull();
            expect(dlPath!).toMatch(/\.temp-.+-[0-9a-f]+\.btrfs$/);
            expect(path.dirname(dlPath!)).toBe(tempDir);
        });

        it("returns null when cache dir creation fails", async () => {
            // Use a path that can't be created (file exists where dir would be)
            const blockingFile = path.join(tempDir, "blocker");
            await fs.writeFile(blockingFile, "I block mkdir");
            const nlc = new NodeLocalCache(
                path.join(blockingFile, "subdir"),
                "key",
                ".btrfs"
            );
            const dlPath = await nlc.getDownloadPath();
            expect(dlPath).toBeNull();
        });

        it("direct download flow: download to temp, commit, file exists at final path", async () => {
            const nlc = new NodeLocalCache(tempDir, "direct-dl", ".btrfs");

            // Step 1: get download path
            const dlPath = await nlc.getDownloadPath();
            expect(dlPath).not.toBeNull();

            // Step 2: simulate S3 download writing directly to this path
            await fs.writeFile(dlPath!, "s3-image-data");

            // Step 3: commit (atomic mv)
            const won = await nlc.commitTempFile(dlPath!);
            expect(won).toBe(true);

            // Final file should exist with the downloaded data
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("s3-image-data");

            // Temp path should be gone (it was renamed)
            await expect(fs.access(dlPath!)).rejects.toThrow();
        });
    });

    describe("cleanupStaleTempFiles", () => {
        it("returns 0 when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            expect(await nlc.cleanupStaleTempFiles()).toBe(0);
        });

        it("returns 0 when cache dir does not exist", async () => {
            const nlc = new NodeLocalCache(
                "/nonexistent/path",
                "key",
                ".btrfs"
            );
            expect(await nlc.cleanupStaleTempFiles()).toBe(0);
        });

        it("removes temp files older than 12 hours", async () => {
            const nlc = new NodeLocalCache(tempDir, "key", ".btrfs");

            // Create an "old" temp file (set mtime to 13 hours ago)
            const oldTemp = path.join(tempDir, ".temp_old_file.btrfs");
            await fs.writeFile(oldTemp, "old");
            const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
            await fs.utimes(oldTemp, thirteenHoursAgo, thirteenHoursAgo);

            // Create a "fresh" temp file (current time)
            const freshTemp = path.join(tempDir, ".temp_fresh_file.btrfs");
            await fs.writeFile(freshTemp, "fresh");

            // Create a non-temp file (should not be touched)
            const normalFile = path.join(tempDir, "cache-key.btrfs");
            await fs.writeFile(normalFile, "normal");

            const cleaned = await nlc.cleanupStaleTempFiles();
            expect(cleaned).toBe(1);

            // Old temp should be deleted
            await expect(fs.access(oldTemp)).rejects.toThrow();

            // Fresh temp should remain
            await expect(fs.access(freshTemp)).resolves.toBeUndefined();

            // Normal file should remain
            await expect(fs.access(normalFile)).resolves.toBeUndefined();
        });

        it("does not remove temp files younger than 12 hours", async () => {
            const nlc = new NodeLocalCache(tempDir, "key", ".btrfs");

            const recentTemp = path.join(tempDir, ".temp_recent.btrfs");
            await fs.writeFile(recentTemp, "recent");
            const elevenHoursAgo = new Date(Date.now() - 11 * 60 * 60 * 1000);
            await fs.utimes(recentTemp, elevenHoursAgo, elevenHoursAgo);

            const cleaned = await nlc.cleanupStaleTempFiles();
            expect(cleaned).toBe(0);

            // File should still exist
            await expect(fs.access(recentTemp)).resolves.toBeUndefined();
        });
    });

    describe("concurrent access safety", () => {
        it("second download+commit returns false after first succeeds", async () => {
            const nlc = new NodeLocalCache(tempDir, "concurrent-key", ".btrfs");

            // First runner: getDownloadPath → write → commit
            const dlPath1 = await nlc.getDownloadPath();
            expect(dlPath1).not.toBeNull();
            await fs.writeFile(dlPath1!, "data-first");
            const result1 = await nlc.commitTempFile(dlPath1!);
            expect(result1).toBe(true);

            // Second runner: getDownloadPath → write → commit (should lose)
            const dlPath2 = await nlc.getDownloadPath();
            expect(dlPath2).not.toBeNull();
            await fs.writeFile(dlPath2!, "data-second");
            const result2 = await nlc.commitTempFile(dlPath2!);
            expect(result2).toBe(false);

            // The file should contain the first runner's data
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("data-first");
        });

        it("commitTempFile returns false when another runner already placed file", async () => {
            const nlc = new NodeLocalCache(tempDir, "race-commit", ".btrfs");

            // Another runner already placed the file
            await fs.writeFile(nlc.localPath, "existing");

            const tempPath = await nlc.createTempFile();
            expect(tempPath).not.toBeNull();
            await fs.writeFile(tempPath!, "ours");

            const won = await nlc.commitTempFile(tempPath!);
            expect(won).toBe(false);

            // Original content preserved
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("existing");
        });
    });

    describe("findClosestMatch", () => {
        it("returns null when disabled", async () => {
            const nlc = new NodeLocalCache("", "my-key", ".btrfs");
            const result = await nlc.findClosestMatch(["prefix-"]);
            expect(result).toBeNull();
        });

        it("returns null when no restore keys provided", async () => {
            const nlc = new NodeLocalCache(tempDir, "my-key", ".btrfs");
            const result = await nlc.findClosestMatch([]);
            expect(result).toBeNull();
        });

        it("returns null when no files match restore keys", async () => {
            const nlc = new NodeLocalCache(tempDir, "my-key", ".btrfs");
            await fs.writeFile(
                path.join(tempDir, "unrelated-key.btrfs"),
                "data"
            );
            const result = await nlc.findClosestMatch(["nodemodules-"]);
            expect(result).toBeNull();
        });

        it("finds a file matching restore-key prefix", async () => {
            const nlc = new NodeLocalCache(
                tempDir,
                "nodemodules-abc123",
                ".btrfs"
            );
            const matchFile = path.join(tempDir, "nodemodules-old-hash.btrfs");
            await fs.writeFile(matchFile, "cached-data");
            const result = await nlc.findClosestMatch(["nodemodules-"]);
            expect(result).toBe(matchFile);
        });

        it("returns newest file when multiple matches exist", async () => {
            const nlc = new NodeLocalCache(tempDir, "nm-exact", ".btrfs");

            const oldFile = path.join(tempDir, "nm-hash1.btrfs");
            const newFile = path.join(tempDir, "nm-hash2.btrfs");
            await fs.writeFile(oldFile, "old-data");
            // Ensure newFile has a later mtime
            await new Promise(r => setTimeout(r, 50));
            await fs.writeFile(newFile, "new-data");

            const result = await nlc.findClosestMatch(["nm-"]);
            expect(result).toBe(newFile);
        });

        it("ignores temp files", async () => {
            const nlc = new NodeLocalCache(tempDir, "my-key", ".btrfs");
            await fs.writeFile(
                path.join(tempDir, ".tempabc.btrfs"),
                "temp-data"
            );
            const result = await nlc.findClosestMatch(["my-"]);
            expect(result).toBeNull();
        });

        it("ignores files with wrong extension", async () => {
            const nlc = new NodeLocalCache(tempDir, "my-key", ".btrfs");
            await fs.writeFile(
                path.join(tempDir, "my-key-old.tar.lz4"),
                "tar-data"
            );
            const result = await nlc.findClosestMatch(["my-key-"]);
            expect(result).toBeNull();
        });

        it("matches multiple restore-key prefixes", async () => {
            const nlc = new NodeLocalCache(tempDir, "nm-exact-hash", ".btrfs");
            const fallbackFile = path.join(tempDir, "nm-fallback.btrfs");
            await fs.writeFile(fallbackFile, "fallback-data");

            // First prefix doesn't match, second does
            const result = await nlc.findClosestMatch(["nm-exact-", "nm-"]);
            expect(result).toBe(fallbackFile);
        });
    });

    describe("acquirePopulateLockOrWait (in-flight coalesce)", () => {
        it("first caller gets 'populate' and creates the lock dir", async () => {
            const nlc = new NodeLocalCache(tempDir, "keyA", ".btrfs");
            const decision = await nlc.acquirePopulateLockOrWait();
            expect(decision).toBe("populate");
            await expect(
                fs.access(path.join(tempDir, "keyA.lock.d"))
            ).resolves.toBeUndefined();
        });

        it("returns 'hit' immediately when the final image already exists", async () => {
            const nlc = new NodeLocalCache(tempDir, "keyHit", ".btrfs");
            await fs.writeFile(path.join(tempDir, "keyHit.btrfs"), "image");
            expect(await nlc.acquirePopulateLockOrWait()).toBe("hit");
        });

        it("release removes the lock dir", async () => {
            const nlc = new NodeLocalCache(tempDir, "keyR", ".btrfs");
            await nlc.acquirePopulateLockOrWait();
            await nlc.releasePopulateLock();
            await expect(
                fs.access(path.join(tempDir, "keyR.lock.d"))
            ).rejects.toThrow();
        });

        it("a DIFFERENT key's active temp file does NOT read as liveness (multi-hash gap)", async () => {
            // keyB holds a lock but never writes a keyB temp; meanwhile keyOther
            // has a fresh temp download in flight. A waiter on keyB must judge
            // keyB DEAD (its own temp is absent) and not be fooled by keyOther's.
            const other = new NodeLocalCache(tempDir, "keyOther", ".btrfs");
            const otherTemp = await other.getDownloadPath(); // .temp-keyOther-...
            expect(otherTemp).not.toBeNull();
            await fs.writeFile(otherTemp as string, "downloading"); // fresh mtime

            // Pre-create keyB's lock dir aged past the grace window so it's eligible
            // for the liveness check (backdate its mtime).
            const lockB = path.join(tempDir, "keyB.lock.d");
            await fs.mkdir(lockB);
            const old = new Date(Date.now() - 5 * 60_000);
            await fs.utimes(lockB, old, old);

            const nlc = new NodeLocalCache(tempDir, "keyB", ".btrfs");
            // Should STEAL (keyB has no fresh temp of its own) and return populate,
            // NOT hang waiting on keyOther's temp.
            const decision = await nlc.acquirePopulateLockOrWait();
            expect(decision).toBe("populate");
        });
    });
});
