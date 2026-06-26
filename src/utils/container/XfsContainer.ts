/**
 * XfsContainer — thin XFS-specific orchestrator.
 *
 * All fs-agnostic orchestration (bind mounts, node-local hot path, copy+UUID
 * WORM flow, mount discovery, unmount, cleanup, path-traversal) lives in
 * LoopContainer. This class supplies only the XFS specifics: the XfsImage
 * instance, the ".xfs" node-local extension, isSupportedMethod, the "[XFS]"
 * log prefix, the findmnt fs-type, and the explicit zstd compress/decompress
 * around the S3 round-trip.
 *
 * Target: runner nodes whose kernel has NO btrfs support but DOES have xfs
 * builtin (Bottlerocket: CONFIG_BTRFS_FS unset, CONFIG_XFS_FS=y). Callers pass
 * `custom-compression: xfs`.
 *
 * CRITICAL: XFS has no transparent compression and cannot be shrunk. So the S3
 * artifact is compressed EXPLICITLY with zstd:
 *   - The xfs image is built/mounted at a RAW working path (<safeCwd>/cache.xfs).
 *   - On save(): after unmount + verify, the raw image is zstd-compressed into
 *     this.containerFile (= archivePath that cache.ts uploads). The raw image is
 *     KEPT (no zstd --rm) so the node-local commit can copy the RAW image.
 *   - On restore() (S3 path): the downloaded artifact at this.containerFile is
 *     zstd-compressed → decompress to a raw working file first, then loop-mount.
 *   - Node-local WORM images are always RAW .xfs (direct loop mount), exactly
 *     like btrfs. tryRestoreFromNodeLocal mounts them directly (no decompress).
 *   - commitNodeLocalDownload is overridden so the RAW image (not the compressed
 *     archive) is what gets persisted to the node-local WORM dir.
 */
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

import { ContainerOptions } from "./Container";
import { LoopContainer } from "./LoopContainer";
import { LoopImage } from "./LoopImage";
import { parseZstdLevel, validateFsSize, XfsImage } from "./XfsImage";

export class XfsContainer extends LoopContainer {
    private readonly xfsImage: XfsImage;
    private readonly zstdLevel: number;

    constructor(
        containerFile: string,
        compressionMethod: string,
        compressionLevel: string | undefined,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerOptions
    ) {
        super(
            containerFile,
            compressionMethod,
            compressionLevel,
            baseDir,
            pathsToCache,
            cacheKey,
            options
        );

        // Input validation
        validateFsSize(this.fsSize);

        // zstd level for the explicit S3 compression (default zstd:3 → 3)
        this.zstdLevel = parseZstdLevel(
            options.saveCompressionLevel || "zstd:3"
        );

        // The image is built/mounted at the RAW working path. The actual path
        // is finalized in initialize() (setupRawImagePath) once safeCwd exists.
        this.xfsImage = new XfsImage(this.rawImageFile, {
            rwUtilizationTarget: 0.8,
            safeCwd: "" // set in initialize()
        });
    }

    protected get image(): LoopImage {
        return this.xfsImage;
    }

    protected get fsDisplayName(): string {
        return "XFS";
    }

    protected getLogPrefix(): string {
        return "[XFS]";
    }

    protected tmpPrefix(): string {
        return "xfs";
    }

    protected nodeLocalExtension(): string {
        return ".xfs";
    }

    isSupportedMethod(method?: string): boolean {
        return (method?.split("-")[0] || method) === "xfs";
    }

    protected findmntFsType(): string {
        return "xfs";
    }

    protected localCopyName(): string {
        return "cache.xfs";
    }

    /**
     * Build/mount the xfs image at a raw working path inside safeCwd so the
     * S3 artifact path (this.containerFile) is free to hold compressed bytes.
     */
    protected async setupRawImagePath(): Promise<void> {
        this.rawImageFile = path.join(this.safeCwd, "cache.xfs");
        this.xfsImage.setImageFile(this.rawImageFile);
    }

    /**
     * S3 artifact at this.containerFile is zstd-compressed. Decompress it to the
     * raw working image so the base restore() can loop-mount the raw image.
     */
    protected async prepareRawForRestore(): Promise<void> {
        await this.decompressToRaw(this.containerFile, this.rawImageFile);
        this.xfsImage.setImageFile(this.rawImageFile);
    }

    /**
     * Explicitly zstd-compress the RAW image into this.containerFile (= the
     * archivePath that cache.ts uploads). The raw image is KEPT so the
     * node-local commit (commitNodeLocalDownload override) can persist it
     * uncompressed for direct loop mounting on future runs.
     */
    protected async finalizeSaveArtifact(): Promise<void> {
        await this.compressRawToArchive(this.rawImageFile, this.containerFile);
    }

    protected extraStaleFiles(): string[] {
        return [this.rawImageFile];
    }

    /**
     * The save step runs in a SEPARATE process from restore/createEmptyCache,
     * so its per-run mkdtemp safeCwd differs and setupRawImagePath() points
     * rawImageFile at a <safeCwd>/cache.xfs that was never created in THIS
     * process — the real raw image lives in the restore process's safeCwd. The
     * loop mount survives across processes (kernel state), so discoverMountInfo
     * finds it, but getImageFile() would resolve to the wrong, non-existent
     * path → the live ENOENT seen in verifyMountable (stat '<safeCwd>/cache.xfs').
     *
     * Recover the real backing file from the live loop device (`losetup`) and
     * re-point rawImageFile + the XfsImage at it, so verifyMountable() and
     * finalizeSaveArtifact() operate on the file that actually exists.
     */
    protected async onMountDiscovered(source: string): Promise<void> {
        if (!source.startsWith("/dev/loop")) return;
        try {
            const out = await exec.getExecOutput(
                "losetup",
                ["-nO", "BACK-FILE", source],
                {
                    cwd: this.safeCwd,
                    silent: !core.isDebug(),
                    ignoreReturnCode: true
                }
            );
            // losetup may append " (deleted)" if the backing file was unlinked.
            const backFile = out.stdout
                .trim()
                .replace(/\s*\(deleted\)\s*$/, "")
                .trim();
            if (out.exitCode === 0 && backFile) {
                this.logInfo(
                    `Resolved live xfs backing file from ${source}: ${backFile}`
                );
                this.rawImageFile = backFile;
                this.xfsImage.setImageFile(backFile);
            } else {
                core.warning(
                    `${this.getLogPrefix()} Could not resolve backing file for ${source}; ` +
                        `verify will use ${this.rawImageFile}`
                );
            }
        } catch (err) {
            core.warning(
                `${this.getLogPrefix()} losetup BACK-FILE lookup failed for ${source}: ${
                    err instanceof Error ? err.message : err
                }`
            );
        }
    }

    /**
     * Sparse-preserving copy of the raw xfs image. The raw image is a sparse
     * 25G file (truncate -s 25G + mkfs.xfs) with only ~7-15G of actual data
     * blocks allocated. fs.copyFile does NOT preserve holes on Linux and would
     * balloon the copy to 25G physical on disk, so we use
     * `cp --sparse=always` (via the async exec helper, never execFileSync) to
     * keep the copy sparse end-to-end.
     */
    protected async copyImage(src: string, dst: string): Promise<void> {
        await exec.exec("cp", ["--sparse=always", src, dst], {
            cwd: this.safeCwd,
            silent: !core.isDebug()
        });
    }

    /**
     * Keep XfsImage.imageFile in sync with Container.containerFile ONLY for the
     * raw-image case. When containerFile points at a compressed S3 artifact we
     * must NOT point the image at it — restore() decompresses to rawImageFile
     * first. We therefore deliberately do NOT forward to image.setImageFile here;
     * restore()/mount paths set the image file to the raw path explicitly.
     */
    setArchivePath(archivePath: string): void {
        super.setArchivePath(archivePath);
    }

    /**
     * Override node-local commit so the RAW image is persisted to the WORM dir,
     * NOT the compressed archive that cache.ts copied into tempPath.
     *
     * cache.ts (save path) does: copyFile(archivePath → tempPath) then
     * commitNodeLocalDownload(tempPath). For XFS, archivePath is compressed, but
     * the node-local WORM copy must be RAW for direct loop mount. So we overwrite
     * tempPath with the raw image before delegating to the base commit.
     *
     * On the S3 RESTORE path, tempPath holds the freshly downloaded COMPRESSED
     * artifact — decompress it in place so the node-local WORM copy is raw. We
     * distinguish the two by whether rawImageFile currently exists.
     */
    async commitNodeLocalDownload(tempPath: string): Promise<boolean> {
        try {
            // Save path: rawImageFile exists and is the source of truth — copy it
            // over tempPath so the WORM copy is raw.
            let rawExists = false;
            try {
                await fs.access(this.rawImageFile);
                rawExists = true;
            } catch {
                /* no raw image */
            }

            if (rawExists) {
                this.logInfo(
                    "Persisting RAW xfs image to node-local (not the compressed archive)"
                );
                // Sparse-preserving copy — the kept node-local WORM image must
                // stay sparse (Problem 2); fs.copyFile would balloon it to 25G.
                await this.copyImage(this.rawImageFile, tempPath);
            } else {
                // Restore path: tempPath holds the freshly downloaded COMPRESSED
                // artifact. Decompress it in place so the node-local WORM copy is
                // raw and directly loop-mountable by future runners.
                this.logInfo(
                    "Decompressing downloaded artifact before node-local commit (WORM must be raw)"
                );
                const decompressed = `${tempPath}.raw`;
                await this.decompressToRaw(tempPath, decompressed);
                await fs.rename(decompressed, tempPath);
            }
        } catch (err) {
            core.warning(
                `${this.getLogPrefix()} Failed to prepare raw image for node-local commit: ${
                    err instanceof Error ? err.message : err
                }`
            );
            // Fall through to base commit anyway (best-effort).
        }
        return super.commitNodeLocalDownload(tempPath);
    }

    shouldSkipS3Upload(): boolean {
        return super.shouldSkipS3Upload() || this.restoredFromNodeLocal;
    }

    // ── Compression helpers (explicit zstd for S3) ───────────────────

    private async compressRawToArchive(
        rawFile: string,
        archive: string
    ): Promise<void> {
        this.logInfo(
            `Compressing raw XFS image with zstd -${this.zstdLevel}: ${rawFile} → ${archive}`
        );
        // Stream via Node's built-in zlib zstd (node24) — no `zstd` CLI / exec.
        // The source is kept (we read it, never remove it) so the node-local
        // commit can still copy the RAW image afterwards.
        await pipeline(
            createReadStream(rawFile),
            zlib.createZstdCompress({
                params: {
                    [zlib.constants.ZSTD_c_compressionLevel]: this.zstdLevel
                }
            }),
            createWriteStream(archive)
        );

        const [srcStat, dstStat] = await Promise.all([
            fs.stat(rawFile),
            fs.stat(archive)
        ]);
        this.logInfo(
            `Compressed ${Math.round(srcStat.size / (1024 * 1024))} MB → ` +
                `${Math.round(dstStat.size / (1024 * 1024))} MB`
        );
    }

    private async decompressToRaw(
        archive: string,
        rawFile: string
    ): Promise<void> {
        this.logInfo(
            `Decompressing artifact with zstd: ${archive} → ${rawFile}`
        );
        // Stream via Node's built-in zlib zstd (node24) — no `zstd` CLI / exec.
        // NOTE: streaming decompress writes a NORMAL (non-sparse) file. That is
        // acceptable here because the decompressed output is a transient working
        // image that is immediately loop-mounted and (on restore) expanded; the
        // SAVED / kept node-local copy is produced by sparse-preserving copies
        // (see commitNodeLocalDownload / copyAndMountReadWrite), per Problem 2.
        await pipeline(
            createReadStream(archive),
            zlib.createZstdDecompress(),
            createWriteStream(rawFile)
        );
    }
}
