import { getGnuTarPathOnWindows } from "@actions/cache/lib/internal/cacheUtils";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { TarLz4Container } from "../src/utils/container/TarLz4Container";

const windowsTest = process.platform === "win32" ? it : it.skip;
const symbolicLinkTest = process.platform === "win32" ? it.skip : it;

describe("TarLz4Container filesystem round trips", () => {
    let sandbox: string;
    let workspace: string;
    let archivePath: string;

    beforeEach(async () => {
        sandbox = await fs.mkdtemp(
            path.join(os.tmpdir(), "tar-lz4-filesystem-")
        );
        workspace = path.join(sandbox, "workspace");
        archivePath = path.join(sandbox, "cache.tar");
        await fs.mkdir(workspace);
    });

    afterEach(async () => {
        await fs.rm(sandbox, { recursive: true, force: true });
    });

    function createContainer(
        pathsToCache: string[],
        compressionMethod = "none"
    ): TarLz4Container {
        return new TarLz4Container(
            archivePath,
            compressionMethod,
            undefined,
            workspace,
            pathsToCache,
            "filesystem-test",
            {}
        );
    }

    async function listArchive(): Promise<string[]> {
        const tarPath =
            process.platform === "win32"
                ? await getGnuTarPathOnWindows()
                : "tar";
        if (!tarPath) {
            throw new Error(
                "Git for Windows GNU tar is required for this test"
            );
        }
        return execFileSync(tarPath, ["-tf", archivePath], {
            encoding: "utf8"
        })
            .split(/\r?\n/)
            .filter(Boolean);
    }

    windowsTest(
        "preserves a directory junction without archiving its external target",
        async () => {
            const selectedRoot = path.join(workspace, "selected root");
            const externalTarget = path.join(sandbox, "external target");
            const junction = path.join(selectedRoot, "directory junction");
            const unrelatedFile = path.join(externalTarget, "unrelated.txt");
            await fs.mkdir(selectedRoot);
            await fs.mkdir(externalTarget);
            await fs.writeFile(unrelatedFile, "not selected");
            await fs.symlink(externalTarget, junction, "junction");

            const container = createContainer([
                path.relative(workspace, selectedRoot)
            ]);
            await container.save();

            expect(await listArchive()).not.toEqual(
                expect.arrayContaining([
                    expect.stringContaining("unrelated.txt")
                ])
            );

            await fs.rm(junction);
            await fs.rm(unrelatedFile);
            await container.restore();

            expect((await fs.lstat(junction)).isSymbolicLink()).toBe(true);
            expect(await fs.realpath(junction)).toBe(
                await fs.realpath(externalTarget)
            );
            await expect(fs.access(unrelatedFile)).rejects.toThrow();
        }
    );

    it("round trips an LZ4-compressed directory", async () => {
        archivePath = path.join(sandbox, "cache.lz4");
        const selectedPath = "compressed-root";
        const selectedRoot = path.join(workspace, selectedPath);
        const selectedFile = path.join(selectedRoot, "value.txt");
        await fs.mkdir(selectedRoot);
        await fs.writeFile(selectedFile, "compressed");

        const container = createContainer([selectedPath], "lz4");
        await container.save();
        expect((await fs.readFile(archivePath)).subarray(0, 4)).toEqual(
            Buffer.from([0x04, 0x22, 0x4d, 0x18])
        );
        await fs.rm(selectedRoot, { recursive: true });
        await container.restore();

        expect(await fs.readFile(selectedFile, "utf8")).toBe("compressed");
    });

    it("round trips a single nested directory whose platform path contains spaces", async () => {
        const selectedPath = path.join("single root", "nested directory");
        const selectedRoot = path.join(workspace, "single root");
        const selectedFile = path.join(workspace, selectedPath, "value.txt");
        await fs.mkdir(path.dirname(selectedFile), { recursive: true });
        await fs.writeFile(selectedFile, "inside workspace");

        const container = createContainer([selectedPath]);
        await container.save();
        await fs.rm(selectedRoot, { recursive: true });
        await container.restore();

        expect(await fs.readFile(selectedFile, "utf8")).toBe(
            "inside workspace"
        );
    });

    it("round trips multiple caller-supplied paths inside and outside the workspace", async () => {
        const firstPath = path.join("first root", "nested");
        const secondPath = path.join("second-root");
        const externalPath = path.join(sandbox, "outside workspace");
        const firstFile = path.join(workspace, firstPath, "first.txt");
        const secondFile = path.join(workspace, secondPath, "second.txt");
        const externalFile = path.join(externalPath, "external.txt");
        await fs.mkdir(path.dirname(firstFile), { recursive: true });
        await fs.mkdir(path.dirname(secondFile), { recursive: true });
        await fs.mkdir(externalPath);
        await fs.writeFile(firstFile, "first");
        await fs.writeFile(secondFile, "second");
        await fs.writeFile(externalFile, "external");

        const container = createContainer([
            firstPath,
            secondPath,
            externalPath
        ]);
        await container.save();
        await fs.rm(path.join(workspace, "first root"), { recursive: true });
        await fs.rm(path.join(workspace, secondPath), { recursive: true });
        await fs.rm(externalPath, { recursive: true });
        await container.restore();

        await expect(fs.readFile(firstFile, "utf8")).resolves.toBe("first");
        await expect(fs.readFile(secondFile, "utf8")).resolves.toBe("second");
        await expect(fs.readFile(externalFile, "utf8")).resolves.toBe(
            "external"
        );
    });

    symbolicLinkTest(
        "preserves a symbolic link without archiving its external target",
        async () => {
            const selectedRoot = path.join(workspace, "selected root");
            const nestedDirectory = path.join(selectedRoot, "nested directory");
            const externalTarget = path.join(sandbox, "external target");
            const symbolicLink = path.join(selectedRoot, "symbolic link");
            const unrelatedFile = path.join(externalTarget, "unrelated.txt");
            await fs.mkdir(nestedDirectory, { recursive: true });
            await fs.writeFile(
                path.join(nestedDirectory, "selected.txt"),
                "selected"
            );
            await fs.mkdir(externalTarget);
            await fs.writeFile(unrelatedFile, "not selected");
            await fs.symlink(externalTarget, symbolicLink, "dir");

            const container = createContainer([
                path.relative(workspace, selectedRoot)
            ]);
            await container.save();

            expect(await listArchive()).not.toEqual(
                expect.arrayContaining([
                    expect.stringContaining("unrelated.txt")
                ])
            );

            await fs.rm(symbolicLink);
            await fs.rm(unrelatedFile);
            await container.restore();

            expect((await fs.lstat(symbolicLink)).isSymbolicLink()).toBe(true);
            expect(await fs.realpath(symbolicLink)).toBe(
                await fs.realpath(externalTarget)
            );
            await expect(fs.access(unrelatedFile)).rejects.toThrow();
        }
    );
});
