import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
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

    describe("localPath", () => {
        it("constructs correct path for btrfs", () => {
            const nlc = new NodeLocalCache("/opt/cache", "node-modules-abc123", ".btrfs");
            expect(nlc.localPath).toBe("/opt/cache/node-modules-abc123.btrfs");
        });

        it("constructs correct path for vhdx", () => {
            const nlc = new NodeLocalCache("/opt/cache", "my-cache-key", ".vhdx");
            expect(nlc.localPath).toBe("/opt/cache/my-cache-key.vhdx");
        });

        it("constructs correct path for tar.lz4", () => {
            const nlc = new NodeLocalCache("/opt/cache", "my-key", ".tar.lz4");
            expect(nlc.localPath).toBe("/opt/cache/my-key.tar.lz4");
        });

        it("sanitizes keys with path separators", () => {
            const nlc = new NodeLocalCache("/opt/cache", "my/key:with*special", ".btrfs");
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
        it("throws when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            await expect(nlc.createTempFile()).rejects.toThrow("node-local caching is disabled");
        });

        it("creates temp file path in cache dir", async () => {
            const nlc = new NodeLocalCache(tempDir, "key", ".btrfs");
            const tempPath = await nlc.createTempFile();
            expect(tempPath).toMatch(/\.temp[0-9a-f]+\.btrfs$/);
            expect(path.dirname(tempPath)).toBe(tempDir);
        });

        it("creates cache dir if missing", async () => {
            const nestedDir = path.join(tempDir, "nested", "cache");
            const nlc = new NodeLocalCache(nestedDir, "key", ".btrfs");
            const tempPath = await nlc.createTempFile();
            expect(tempPath).toContain(nestedDir);
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
            await fs.writeFile(tempPath, "test-data");

            const won = await nlc.commitTempFile(tempPath);
            expect(won).toBe(true);

            // Final file should exist
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("test-data");

            // Temp file should be gone
            await expect(fs.access(tempPath)).rejects.toThrow();
        });

        it("returns false and cleans up when another runner already placed the file", async () => {
            const nlc = new NodeLocalCache(tempDir, "race-test", ".btrfs");

            // Another runner already placed the file
            await fs.writeFile(nlc.localPath, "existing-data");

            const tempPath = await nlc.createTempFile();
            await fs.writeFile(tempPath, "our-data");

            const won = await nlc.commitTempFile(tempPath);
            expect(won).toBe(false);

            // Original file should remain unchanged
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("existing-data");

            // Temp file should be cleaned up
            await expect(fs.access(tempPath)).rejects.toThrow();
        });
    });

    describe("persistFromS3Download", () => {
        it("returns false when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            expect(await nlc.persistFromS3Download("/some/archive")).toBe(false);
        });

        it("copies S3 download to node-local cache", async () => {
            const nlc = new NodeLocalCache(tempDir, "s3-persist-test", ".btrfs");

            // Create a fake S3 download
            const s3Path = path.join(tempDir, "s3-download.btrfs");
            await fs.writeFile(s3Path, "s3-image-data");

            const result = await nlc.persistFromS3Download(s3Path);
            expect(result).toBe(true);

            // Verify the file was persisted
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("s3-image-data");
        });

        it("returns false if copy fails (source missing)", async () => {
            const nlc = new NodeLocalCache(tempDir, "bad-source", ".btrfs");
            const result = await nlc.persistFromS3Download("/nonexistent/path");
            expect(result).toBe(false);
        });

        it("skips if file already exists on node", async () => {
            const nlc = new NodeLocalCache(tempDir, "already-exists", ".btrfs");

            // Pre-populate the node-local cache
            await fs.writeFile(nlc.localPath, "existing-node-data");

            // Try to persist from S3
            const s3Path = path.join(tempDir, "s3-new.btrfs");
            await fs.writeFile(s3Path, "new-s3-data");
            const result = await nlc.persistFromS3Download(s3Path);

            // Should return false (didn't win the race)
            expect(result).toBe(false);

            // Original should remain
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("existing-node-data");
        });
    });

    describe("cleanupStaleTempFiles", () => {
        it("returns 0 when disabled", async () => {
            const nlc = new NodeLocalCache("", "key", ".btrfs");
            expect(await nlc.cleanupStaleTempFiles()).toBe(0);
        });

        it("returns 0 when cache dir does not exist", async () => {
            const nlc = new NodeLocalCache("/nonexistent/path", "key", ".btrfs");
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
        it("subsequent calls return false after first persist succeeds", async () => {
            const nlc = new NodeLocalCache(tempDir, "concurrent-key", ".btrfs");

            const s3Path = path.join(tempDir, "s3-download.btrfs");
            await fs.writeFile(s3Path, "data-first");

            // First persist succeeds
            const result1 = await nlc.persistFromS3Download(s3Path);
            expect(result1).toBe(true);

            // Second persist sees the file exists and skips
            const result2 = await nlc.persistFromS3Download(s3Path);
            expect(result2).toBe(false);

            // The file should exist and contain the first runner's data
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("data-first");
        });

        it("commitTempFile returns false when another runner already placed file", async () => {
            const nlc = new NodeLocalCache(tempDir, "race-commit", ".btrfs");

            // Another runner already placed the file
            await fs.writeFile(nlc.localPath, "existing");

            const tempPath = await nlc.createTempFile();
            await fs.writeFile(tempPath, "ours");

            const won = await nlc.commitTempFile(tempPath);
            expect(won).toBe(false);

            // Original content preserved
            const content = await fs.readFile(nlc.localPath, "utf-8");
            expect(content).toBe("existing");
        });
    });
});
