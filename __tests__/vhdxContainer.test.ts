import * as exec from "@actions/exec";
import * as core from "@actions/core";
import * as fs from "fs/promises";
import * as path from "path";

import { VhdxContainer } from "../src/utils/container/VhdxContainer";
import { ContainerFactory } from "../src/utils/container/ContainerFactory";

jest.mock("@actions/exec");
jest.mock("@actions/core");
jest.mock("fs/promises");

const mockedFs = jest.mocked(fs);

const mockedExec = jest.mocked(exec);
const mockedCore = jest.mocked(core);

const TEST_BASE_DIR = "C:\\Users\\runner\\work\\repo";
const TEST_CACHE_KEY = "Windows-node-abc123";
const TEST_PATHS = ["node_modules"];

function createVhdxContainer(
    overrides: {
        containerFile?: string;
        fsSize?: string;
        bufferMb?: number;
        pathsToCache?: string[];
    } = {}
): VhdxContainer {
    const containerFile =
        overrides.containerFile ||
        path.join(TEST_BASE_DIR, "tmp", "cache.vhdx");
    return new VhdxContainer(
        containerFile,
        "vhdx",
        undefined,
        TEST_BASE_DIR,
        overrides.pathsToCache ?? TEST_PATHS,
        TEST_CACHE_KEY,
        {
            fsSize: overrides.fsSize ?? "50G",
            bufferMb: overrides.bufferMb ?? 512
        }
    );
}

beforeEach(() => {
    jest.clearAllMocks();

    // Mock platform as Windows
    Object.defineProperty(process, "platform", { value: "win32" });

    // Default mock for exec
    mockedExec.exec.mockResolvedValue(0);

    // Mock core methods
    mockedCore.isDebug.mockReturnValue(false);
    mockedCore.info.mockImplementation(() => {});
    mockedCore.debug.mockImplementation(() => {});
    mockedCore.warning.mockImplementation(() => {});
    mockedCore.setFailed.mockImplementation(() => {});

    // Default fs mocks
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.rm.mockResolvedValue(undefined);
    mockedFs.lstat.mockRejectedValue(new Error("ENOENT"));
});

describe("VhdxContainer constructor", () => {
    test("creates with valid options", () => {
        const container = createVhdxContainer();
        expect(container.requiresCreateEmptyCache).toBe(true);
        expect(container.requiresKeepArchive).toBe(true);
    });

    test("throws when fsSize is missing", () => {
        expect(
            () =>
                new VhdxContainer(
                    "C:\\tmp\\cache.vhdx",
                    "vhdx",
                    undefined,
                    TEST_BASE_DIR,
                    TEST_PATHS,
                    TEST_CACHE_KEY,
                    {}
                )
        ).toThrow("fsSize option is required");
    });

    test("rejects invalid fsSize format", () => {
        expect(() => createVhdxContainer({ fsSize: "50GB" })).toThrow(
            "Invalid filesystem size format"
        );
    });

    test("accepts valid fsSize formats", () => {
        expect(() => createVhdxContainer({ fsSize: "50G" })).not.toThrow();
        expect(() => createVhdxContainer({ fsSize: "1T" })).not.toThrow();
        expect(() => createVhdxContainer({ fsSize: "512M" })).not.toThrow();
        expect(() => createVhdxContainer({ fsSize: "1024" })).not.toThrow();
    });

    test("rejects path traversal", () => {
        // Use forward slashes which work cross-platform for path traversal
        expect(() =>
            createVhdxContainer({ pathsToCache: ["../../etc/passwd"] })
        ).toThrow("Path traversal detected");
    });
});

describe("VhdxContainer.isSupportedMethod", () => {
    test('returns true for "vhdx"', () => {
        const container = createVhdxContainer();
        expect(container.isSupportedMethod("vhdx")).toBe(true);
    });

    test('returns false for "btrfs"', () => {
        const container = createVhdxContainer();
        expect(container.isSupportedMethod("btrfs")).toBe(false);
    });

    test('returns false for "lz4"', () => {
        const container = createVhdxContainer();
        expect(container.isSupportedMethod("lz4")).toBe(false);
    });

    test("returns false for undefined", () => {
        const container = createVhdxContainer();
        expect(container.isSupportedMethod(undefined)).toBe(false);
    });
});

describe("VhdxContainer.initialize", () => {
    test("checks prerequisites on Windows", async () => {
        const container = createVhdxContainer();
        await container.initialize();

        // Should check for diskpart
        const whereCalls = mockedExec.exec.mock.calls.filter(
            call => call[0] === "where" && call[1]?.[0] === "diskpart"
        );
        expect(whereCalls.length).toBe(1);

        // Should check for Mount-DiskImage cmdlet
        const psCalls = mockedExec.exec.mock.calls.filter(
            call =>
                call[0] === "powershell" &&
                (call[1] as string[])?.some(a =>
                    a.includes("Mount-DiskImage")
                )
        );
        expect(psCalls.length).toBe(1);
    });

    test("fails on non-Windows platforms", async () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        const container = createVhdxContainer();

        const exitSpy = jest
            .spyOn(process, "exit")
            .mockImplementation(() => undefined as never);

        await container.initialize();

        expect(mockedCore.setFailed).toHaveBeenCalledWith(
            expect.stringContaining("only supported on Windows")
        );
        expect(exitSpy).toHaveBeenCalledWith(1);
        exitSpy.mockRestore();
    });
});

describe("VhdxContainer.createEmptyCache", () => {
    test("creates VHDX with diskpart and enables NTFS compression", async () => {
        // Mock PowerShell calls for drive discovery
        mockedExec.exec.mockImplementation(async (cmd, args, options) => {
            if (
                cmd === "powershell" &&
                (args as string[])?.some(a => a.includes("Get-DiskImage"))
            ) {
                if (options?.listeners?.stdout) {
                    options.listeners.stdout(Buffer.from("V\n"));
                }
                return 0;
            }
            if (
                cmd === "powershell" &&
                (args as string[])?.some(a => a.includes("Get-PSDrive"))
            ) {
                if (options?.listeners?.stdout) {
                    options.listeners.stdout(
                        Buffer.from("107374182400\n")
                    );
                }
                return 0;
            }
            return 0;
        });

        const container = createVhdxContainer();
        await container.createEmptyCache();

        // Should call diskpart
        const diskpartCall = mockedExec.exec.mock.calls.find(
            call => call[0] === "diskpart"
        );
        expect(diskpartCall).toBeDefined();
        expect(diskpartCall![1]).toContain("/s");

        // Should call compact for NTFS compression
        const compactCall = mockedExec.exec.mock.calls.find(
            call => call[0] === "compact"
        );
        expect(compactCall).toBeDefined();

        // Should create junction
        const mklinkCall = mockedExec.exec.mock.calls.find(
            call =>
                call[0] === "cmd" &&
                (call[1] as string[])?.includes("mklink")
        );
        expect(mklinkCall).toBeDefined();
    });
});

describe("VhdxContainer.restore", () => {
    test("mounts VHDX with Mount-DiskImage", async () => {
        // Mock file access check and PowerShell calls
        mockedFs.access.mockResolvedValue(undefined);
        mockedFs.lstat.mockRejectedValue(new Error("ENOENT"));
        mockedFs.mkdir.mockResolvedValue(undefined);

        mockedExec.exec.mockImplementation(async (cmd, args, options) => {
            if (
                cmd === "powershell" &&
                (args as string[])?.some(a => a.includes("Mount-DiskImage"))
            ) {
                return 0;
            }
            if (
                cmd === "powershell" &&
                (args as string[])?.some(a => a.includes("Get-DiskImage"))
            ) {
                if (options?.listeners?.stdout) {
                    options.listeners.stdout(Buffer.from("V\n"));
                }
                return 0;
            }
            return 0;
        });

        const container = createVhdxContainer();
        await container.restore();

        // Should call Mount-DiskImage via PowerShell
        const mountCalls = mockedExec.exec.mock.calls.filter(
            call =>
                call[0] === "powershell" &&
                (call[1] as string[])?.some(a =>
                    a.includes("Mount-DiskImage")
                )
        );
        expect(mountCalls.length).toBeGreaterThanOrEqual(1);
    });

    test("falls back to createEmptyCache if image not found", async () => {
        mockedFs.access.mockRejectedValue(new Error("ENOENT"));

        mockedExec.exec.mockImplementation(async (cmd, args, options) => {
            if (
                cmd === "powershell" &&
                (args as string[])?.some(a => a.includes("Get-DiskImage"))
            ) {
                if (options?.listeners?.stdout) {
                    options.listeners.stdout(Buffer.from("V\n"));
                }
                return 0;
            }
            if (
                cmd === "powershell" &&
                (args as string[])?.some(a => a.includes("Get-PSDrive"))
            ) {
                if (options?.listeners?.stdout) {
                    options.listeners.stdout(
                        Buffer.from("107374182400\n")
                    );
                }
                return 0;
            }
            return 0;
        });

        const container = createVhdxContainer();
        await container.restore();

        // Should create a new cache via diskpart
        const diskpartCall = mockedExec.exec.mock.calls.find(
            call => call[0] === "diskpart"
        );
        expect(diskpartCall).toBeDefined();
    });
});

describe("VhdxContainer.save", () => {
    test("dismounts VHDX after save", async () => {
        // Mock drive letter discovery
        mockedExec.exec.mockImplementation(async (cmd, args, options) => {
            if (
                cmd === "powershell" &&
                (args as string[])?.some(a => a.includes("Get-DiskImage"))
            ) {
                if (options?.listeners?.stdout) {
                    options.listeners.stdout(Buffer.from("V\n"));
                }
                return 0;
            }
            return 0;
        });

        const container = createVhdxContainer();
        // Simulate that the drive is already mounted
        (container as any).mountDriveLetter = "V";

        await container.save();

        // Should call Dismount-DiskImage
        const dismountCalls = mockedExec.exec.mock.calls.filter(
            call =>
                call[0] === "powershell" &&
                (call[1] as string[])?.some(a =>
                    a.includes("Dismount-DiskImage")
                )
        );
        expect(dismountCalls.length).toBeGreaterThanOrEqual(1);
    });
});

describe("ContainerFactory VHDX selection", () => {
    test('selects VhdxContainer when customCompression is "vhdx"', () => {
        const container = ContainerFactory.getCacheContainer(
            "vhdx",
            undefined,
            "C:\\tmp\\cache.vhdx",
            TEST_BASE_DIR,
            TEST_PATHS,
            TEST_CACHE_KEY,
            { fsSize: "50G", bufferMb: 512 }
        );
        expect(container).toBeInstanceOf(VhdxContainer);
    });

    test('does not select VhdxContainer for "btrfs"', () => {
        Object.defineProperty(process, "platform", { value: "linux" });
        const container = ContainerFactory.getCacheContainer(
            "btrfs",
            "zstd:3",
            "/tmp/cache.btrfs",
            "/home/runner/work/repo",
            ["node_modules"],
            "Linux-node-abc123",
            { fsSize: "50G", bufferMb: 512 }
        );
        expect(container).not.toBeInstanceOf(VhdxContainer);
    });
});
