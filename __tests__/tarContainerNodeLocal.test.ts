import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock @actions/core first
jest.mock("@actions/core", () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    isDebug: jest.fn(() => false),
    setFailed: jest.fn(),
    getInput: jest.fn(() => "")
}));

// Mock child_process for TarLz4Container which uses execSync directly
jest.mock("child_process", () => ({
    execSync: jest.fn(() => Buffer.from(""))
}));

// Mock @actions/cache tar operations for TarContainer
jest.mock("@actions/cache/lib/internal/tar", () => ({
    extractTar: jest.fn(),
    createTar: jest.fn(),
    listTar: jest.fn()
}));

import { TarLz4Container } from "../src/utils/container/TarLz4Container";
import { TarContainer } from "../src/utils/container/TarContainer";
import { execSync } from "child_process";

describe("TarLz4Container node-local support", () => {
    let tempDir: string;
    let cacheDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tar-nlc-"));
        cacheDir = path.join(tempDir, "node-cache");
        await fs.mkdir(cacheDir, { recursive: true });
        jest.clearAllMocks();
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    function createTarLz4Container(opts: { nodeLocalCacheDir?: string; cacheKey?: string } = {}) {
        const archivePath = path.join(tempDir, "archive.tar.lz4");
        return new TarLz4Container(
            archivePath,
            "lz4",
            undefined,
            tempDir,
            [path.join(tempDir, "node_modules")],
            opts.cacheKey || "test-cache-key",
            {
                nodeLocalCacheDir: opts.nodeLocalCacheDir || "",
                mountMode: "ro"
            }
        );
    }

    describe("tryRestoreFromNodeLocal", () => {
        it("returns false when node-local is disabled", async () => {
            const container = createTarLz4Container();
            expect(await container.tryRestoreFromNodeLocal()).toBe(false);
        });

        it("returns false when node-local file does not exist", async () => {
            const container = createTarLz4Container({ nodeLocalCacheDir: cacheDir });
            expect(await container.tryRestoreFromNodeLocal()).toBe(false);
        });

        it("returns true when node-local file exists", async () => {
            const container = createTarLz4Container({
                nodeLocalCacheDir: cacheDir,
                cacheKey: "local-hit"
            });

            // Create the node-local archive
            const localPath = path.join(cacheDir, "local-hit.tar.lz4");
            await fs.writeFile(localPath, "cached-tar-data");

            const result = await container.tryRestoreFromNodeLocal();
            expect(result).toBe(true);
            expect(execSync).toHaveBeenCalled();
        });

        it("falls back to S3 on restore error", async () => {
            (execSync as jest.Mock).mockImplementationOnce(() => {
                throw new Error("tar extraction failed");
            });

            const container = createTarLz4Container({
                nodeLocalCacheDir: cacheDir,
                cacheKey: "corrupt-key"
            });

            const localPath = path.join(cacheDir, "corrupt-key.tar.lz4");
            await fs.writeFile(localPath, "corrupt");

            const result = await container.tryRestoreFromNodeLocal();
            expect(result).toBe(false);
        });
    });

    describe("shouldSkipS3Upload", () => {
        it("returns false when not restored from node-local", () => {
            const container = createTarLz4Container({ nodeLocalCacheDir: cacheDir });
            expect(container.shouldSkipS3Upload()).toBe(false);
        });

        it("returns true when restored from node-local", async () => {
            const container = createTarLz4Container({
                nodeLocalCacheDir: cacheDir,
                cacheKey: "skip-upload"
            });

            const localPath = path.join(cacheDir, "skip-upload.tar.lz4");
            await fs.writeFile(localPath, "data");

            await container.tryRestoreFromNodeLocal();
            expect(container.shouldSkipS3Upload()).toBe(true);
        });
    });

    describe("initialize", () => {
        it("calls cleanupStaleTempFiles", async () => {
            const container = createTarLz4Container({ nodeLocalCacheDir: cacheDir });

            // Create a stale temp file
            const staleTemp = path.join(cacheDir, ".temp_stale.tar.lz4");
            await fs.writeFile(staleTemp, "stale");
            const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
            await fs.utimes(staleTemp, thirteenHoursAgo, thirteenHoursAgo);

            await container.initialize();

            // Stale temp should be cleaned up
            await expect(fs.access(staleTemp)).rejects.toThrow();
        });
    });
});

describe("TarContainer node-local support", () => {
    let tempDir: string;
    let cacheDir: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tar-nlc-"));
        cacheDir = path.join(tempDir, "node-cache");
        await fs.mkdir(cacheDir, { recursive: true });
        jest.clearAllMocks();
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    function createTarContainer(opts: { nodeLocalCacheDir?: string; cacheKey?: string } = {}) {
        const archivePath = path.join(tempDir, "archive.tar");
        return new TarContainer(
            archivePath,
            "tar",
            undefined,
            tempDir,
            [path.join(tempDir, "node_modules")],
            opts.cacheKey || "test-cache-key",
            {
                nodeLocalCacheDir: opts.nodeLocalCacheDir || "",
                mountMode: "ro"
            }
        );
    }

    describe("tryRestoreFromNodeLocal", () => {
        it("returns false when node-local is disabled", async () => {
            const container = createTarContainer();
            expect(await container.tryRestoreFromNodeLocal()).toBe(false);
        });

        it("returns false when file missing", async () => {
            const container = createTarContainer({ nodeLocalCacheDir: cacheDir });
            expect(await container.tryRestoreFromNodeLocal()).toBe(false);
        });

        it("returns true on node-local hit", async () => {
            const { extractTar } = require("@actions/cache/lib/internal/tar");
            extractTar.mockResolvedValue(undefined);

            const container = createTarContainer({
                nodeLocalCacheDir: cacheDir,
                cacheKey: "tar-hit"
            });

            const localPath = path.join(cacheDir, "tar-hit.tar");
            await fs.writeFile(localPath, "tar-data");

            expect(await container.tryRestoreFromNodeLocal()).toBe(true);
        });

        it("falls back on restore error", async () => {
            const { extractTar } = require("@actions/cache/lib/internal/tar");
            extractTar.mockRejectedValueOnce(new Error("corrupt"));

            const container = createTarContainer({
                nodeLocalCacheDir: cacheDir,
                cacheKey: "corrupt-tar"
            });

            await fs.writeFile(path.join(cacheDir, "corrupt-tar.tar"), "bad");

            expect(await container.tryRestoreFromNodeLocal()).toBe(false);
        });
    });

    describe("shouldSkipS3Upload", () => {
        it("returns false by default", () => {
            const container = createTarContainer({ nodeLocalCacheDir: cacheDir });
            expect(container.shouldSkipS3Upload()).toBe(false);
        });

        it("returns true after node-local restore", async () => {
            const { extractTar } = require("@actions/cache/lib/internal/tar");
            extractTar.mockResolvedValue(undefined);

            const container = createTarContainer({
                nodeLocalCacheDir: cacheDir,
                cacheKey: "tar-skip"
            });

            await fs.writeFile(path.join(cacheDir, "tar-skip.tar"), "data");
            await container.tryRestoreFromNodeLocal();
            expect(container.shouldSkipS3Upload()).toBe(true);
        });
    });

    describe("initialize", () => {
        it("cleans stale temp files", async () => {
            const container = createTarContainer({ nodeLocalCacheDir: cacheDir });

            const staleTemp = path.join(cacheDir, ".temp_old.tar");
            await fs.writeFile(staleTemp, "old");
            const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
            await fs.utimes(staleTemp, thirteenHoursAgo, thirteenHoursAgo);

            await container.initialize();
            await expect(fs.access(staleTemp)).rejects.toThrow();
        });
    });
});
