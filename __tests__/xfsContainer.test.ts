import * as core from "@actions/core";
import * as path from "path";

import { ContainerFactory } from "../src/utils/container/ContainerFactory";
import { XfsContainer } from "../src/utils/container/XfsContainer";
import { parseZstdLevel } from "../src/utils/container/XfsImage";

jest.mock("@actions/exec");
jest.mock("@actions/core");

const mockedCore = jest.mocked(core);

const TEST_BASE_DIR = "/home/runner/work/repo";
const TEST_CACHE_KEY = "Linux-node-abc123";
const TEST_PATHS = ["node_modules"];

function createXfsContainer(
    overrides: {
        fsSize?: string;
        saveCompressionLevel?: string;
        nodeLocalCacheDir?: string;
        mountMode?: "ro" | "rw";
    } = {}
): XfsContainer {
    return new XfsContainer(
        path.join(TEST_BASE_DIR, "tmp", "cache.zst"),
        "xfs",
        undefined,
        TEST_BASE_DIR,
        TEST_PATHS,
        TEST_CACHE_KEY,
        {
            fsSize: overrides.fsSize ?? "50G",
            saveCompressionLevel: overrides.saveCompressionLevel,
            nodeLocalCacheDir: overrides.nodeLocalCacheDir,
            mountMode: overrides.mountMode
        }
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "linux" });
    mockedCore.isDebug.mockReturnValue(false);
    mockedCore.info.mockImplementation(() => {});
    mockedCore.debug.mockImplementation(() => {});
    mockedCore.warning.mockImplementation(() => {});
});

describe("XfsContainer constructor", () => {
    test("creates with valid options", () => {
        const container = createXfsContainer();
        expect(container.requiresCreateEmptyCache).toBe(true);
        expect(container.requiresKeepArchive).toBe(true);
    });

    test("throws when fsSize is missing", () => {
        expect(
            () =>
                new XfsContainer(
                    "/tmp/cache.zst",
                    "xfs",
                    undefined,
                    TEST_BASE_DIR,
                    TEST_PATHS,
                    TEST_CACHE_KEY,
                    {}
                )
        ).toThrow("fsSize option is required");
    });

    test("rejects invalid fsSize format", () => {
        expect(() => createXfsContainer({ fsSize: "50GB" })).toThrow(
            "Invalid filesystem size format"
        );
    });

    test("rejects path traversal in pathsToCache", () => {
        expect(
            () =>
                new XfsContainer(
                    path.join(TEST_BASE_DIR, "tmp", "cache.zst"),
                    "xfs",
                    undefined,
                    TEST_BASE_DIR,
                    ["../../etc/passwd"],
                    TEST_CACHE_KEY,
                    { fsSize: "50G" }
                )
        ).toThrow("Path traversal detected");
    });
});

describe("XfsContainer.isSupportedMethod", () => {
    test('returns true for "xfs"', () => {
        expect(createXfsContainer().isSupportedMethod("xfs")).toBe(true);
    });

    test('returns true for "xfs-zstd"', () => {
        expect(createXfsContainer().isSupportedMethod("xfs-zstd")).toBe(true);
    });

    test('returns false for "btrfs"', () => {
        expect(createXfsContainer().isSupportedMethod("btrfs")).toBe(false);
    });

    test('returns false for "lz4"', () => {
        expect(createXfsContainer().isSupportedMethod("lz4")).toBe(false);
    });

    test("returns false for undefined", () => {
        expect(createXfsContainer().isSupportedMethod(undefined)).toBe(false);
    });
});

describe("parseZstdLevel", () => {
    test('parses "zstd:3" → 3', () => {
        expect(parseZstdLevel("zstd:3")).toBe(3);
    });

    test('parses "zstd" → 3 (default)', () => {
        expect(parseZstdLevel("zstd")).toBe(3);
    });

    test('parses bare "6" → 6', () => {
        expect(parseZstdLevel("6")).toBe(6);
    });

    test("undefined → 3", () => {
        expect(parseZstdLevel(undefined)).toBe(3);
    });

    test("out-of-range → 3", () => {
        expect(parseZstdLevel("zstd:99")).toBe(3);
    });
});

describe("ContainerFactory XFS selection", () => {
    test('selects XfsContainer when customCompression is "xfs"', () => {
        const container = ContainerFactory.getCacheContainer(
            "xfs",
            undefined,
            "/tmp/cache.zst",
            TEST_BASE_DIR,
            TEST_PATHS,
            TEST_CACHE_KEY,
            { fsSize: "50G" }
        );
        expect(container).toBeInstanceOf(XfsContainer);
    });

    test('selects XfsContainer when customCompression is "xfs-zstd"', () => {
        const container = ContainerFactory.getCacheContainer(
            "xfs-zstd",
            undefined,
            "/tmp/cache.zst",
            TEST_BASE_DIR,
            TEST_PATHS,
            TEST_CACHE_KEY,
            { fsSize: "50G" }
        );
        expect(container).toBeInstanceOf(XfsContainer);
    });

    test('does not select XfsContainer for "btrfs"', () => {
        const container = ContainerFactory.getCacheContainer(
            "btrfs",
            "zstd:3",
            "/tmp/cache.btrfs",
            TEST_BASE_DIR,
            TEST_PATHS,
            TEST_CACHE_KEY,
            { fsSize: "50G" }
        );
        expect(container).not.toBeInstanceOf(XfsContainer);
    });
});
