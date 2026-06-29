import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as path from "path";

import * as fsPromises from "node:fs/promises";

import { ContainerFactory } from "../src/utils/container/ContainerFactory";
import { XfsContainer } from "../src/utils/container/XfsContainer";
import { parseZstdLevel, XfsImage } from "../src/utils/container/XfsImage";

jest.mock("node:fs/promises");
const mockedFs = jest.mocked(fsPromises);

jest.mock("@actions/exec");
jest.mock("@actions/core");

const mockedCore = jest.mocked(core);
const mockedExec = jest.mocked(exec);

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

describe("XfsContainer.onMountDiscovered (Problem 1: verify-raw-exists)", () => {
    test("repoints the image at the live loop backing file so verify finds the raw image", async () => {
        const container = createXfsContainer();
        // Simulate the save process: setupRawImagePath() points the image at a
        // fresh-process safeCwd path that was never created in this process.
        await (
            container as unknown as { setupRawImagePath(): Promise<void> }
        ).setupRawImagePath();

        // losetup -nO BACK-FILE /dev/loop7 → the REAL backing file from the
        // restore process's safeCwd (different from this process's path).
        const realBackFile = "/tmp/xfs-restoreProc/cache.xfs";
        mockedExec.getExecOutput.mockResolvedValueOnce({
            exitCode: 0,
            stdout: `${realBackFile}\n`,
            stderr: ""
        });

        await (
            container as unknown as {
                onMountDiscovered(source: string): Promise<void>;
            }
        ).onMountDiscovered("/dev/loop7");

        // The image (what verifyMountable stats) now resolves to the real file.
        const image = (container as unknown as { xfsImage: { getImageFile(): string } })
            .xfsImage;
        expect(image.getImageFile()).toBe(realBackFile);
    });

    test("strips a trailing '(deleted)' marker from the backing file", async () => {
        const container = createXfsContainer();
        await (
            container as unknown as { setupRawImagePath(): Promise<void> }
        ).setupRawImagePath();

        mockedExec.getExecOutput.mockResolvedValueOnce({
            exitCode: 0,
            stdout: "/tmp/xfs-restoreProc/cache.xfs (deleted)\n",
            stderr: ""
        });

        await (
            container as unknown as {
                onMountDiscovered(source: string): Promise<void>;
            }
        ).onMountDiscovered("/dev/loop7");

        const image = (container as unknown as { xfsImage: { getImageFile(): string } })
            .xfsImage;
        expect(image.getImageFile()).toBe("/tmp/xfs-restoreProc/cache.xfs");
    });

    test("ignores non-loop sources (no losetup lookup)", async () => {
        const container = createXfsContainer();
        await (
            container as unknown as { onMountDiscovered(s: string): Promise<void> }
        ).onMountDiscovered("/dev/sda1");
        expect(mockedExec.getExecOutput).not.toHaveBeenCalled();
    });
});

describe("XfsContainer.copyImage (Problem 2: sparse-preserving copy)", () => {
    test("uses `cp --sparse=always` (not fs.copyFile) to keep the image sparse", async () => {
        const container = createXfsContainer();
        mockedExec.exec.mockResolvedValueOnce(0);

        await (
            container as unknown as {
                copyImage(src: string, dst: string): Promise<void>;
            }
        ).copyImage("/tmp/src.xfs", "/tmp/dst.xfs");

        expect(mockedExec.exec).toHaveBeenCalledWith(
            "cp",
            ["--sparse=always", "/tmp/src.xfs", "/tmp/dst.xfs"],
            expect.any(Object)
        );
    });
});

describe("XfsImage RW headroom (warm-restore corruption fix)", () => {
    function createXfsImage(): XfsImage {
        return new XfsImage("/tmp/xfs-proc/cache.xfs", {
            rwUtilizationTarget: 0.8,
            safeCwd: "/tmp/xfs-proc"
        });
    }

    test("computeHeadroomTargetMb returns a grow target sized against physical+free, capped", async () => {
        const image = createXfsImage();
        // apparent 1000 MB, physical 100 MB used
        mockedFs.stat.mockResolvedValueOnce({
            size: 1000 * 1024 * 1024,
            blocks: (100 * 1024 * 1024) / 512
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
        // df --output=avail -B1 → 10000 MB free on host
        mockedExec.exec.mockImplementationOnce(
            async (_cmd, _args, opts) => {
                opts?.listeners?.stdout?.(
                    Buffer.from(`Avail\n${10000 * 1024 * 1024}\n`)
                );
                return 0;
            }
        );

        const targetMb = await image.computeHeadroomTargetMb();
        // budget*target = (100+10000)*0.8 = 8080; cap = 100 + 0.85*10000 = 8600
        // → min = 8080 MB
        expect(targetMb).toBe(8080);
    });

    test("computeHeadroomTargetMb returns null when headroom disabled", async () => {
        const image = new XfsImage("/tmp/x/cache.xfs", {
            rwUtilizationTarget: 0,
            safeCwd: "/tmp/x"
        });
        expect(await image.computeHeadroomTargetMb()).toBeNull();
    });

    test("growBackingFile truncates the backing file up (no losetup -c)", async () => {
        const image = createXfsImage();
        mockedExec.exec.mockResolvedValue(0);

        await image.growBackingFile(8080);

        expect(mockedExec.exec).toHaveBeenCalledWith(
            "truncate",
            ["-s", "8080M", "/tmp/xfs-proc/cache.xfs"],
            expect.any(Object)
        );
        // The corruption trigger must be gone: never a live capacity refresh.
        const calls = mockedExec.exec.mock.calls;
        const losetupC = calls.some(
            ([cmd, args]) =>
                cmd === "sudo" &&
                Array.isArray(args) &&
                args[0] === "losetup" &&
                args[1] === "-c"
        );
        expect(losetupC).toBe(false);
    });

    test("RW restore grows the BACKING FILE before mounting, then the FS after — no losetup -c", async () => {
        const container = createXfsContainer();
        const callOrder: string[] = [];

        const image = (
            container as unknown as { xfsImage: XfsImage }
        ).xfsImage;
        const c = container as unknown as Record<
            string,
            (...args: unknown[]) => Promise<unknown>
        >;

        jest.spyOn(c, "prepareRawForRestore").mockResolvedValue(undefined);
        jest.spyOn(c, "cleanStaleMounts").mockResolvedValue(undefined);
        jest.spyOn(c, "bindMountPaths").mockResolvedValue(undefined);
        jest.spyOn(image, "growBackingFileForHeadroom").mockImplementation(
            async () => {
                callOrder.push("growBackingFile");
                return true;
            }
        );
        jest.spyOn(image, "mountRW").mockImplementation(async () => {
            callOrder.push("mountRW");
        });
        jest.spyOn(image, "growFilesystemForHeadroom").mockImplementation(
            async () => {
                callOrder.push("growFilesystem");
            }
        );
        jest.spyOn(image, "checkHealth").mockResolvedValue(undefined);

        await container.restore();

        expect(callOrder).toEqual([
            "growBackingFile",
            "mountRW",
            "growFilesystem"
        ]);
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
