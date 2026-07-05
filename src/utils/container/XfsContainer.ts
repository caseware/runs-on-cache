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
import * as fs from "node:fs/promises";
import * as path from "node:path";

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
        // When node-local is enabled, the S3-download path (cache.ts) already
        // decompressed the freshly downloaded artifact to a RAW image and
        // committed it to the node-local WORM dir, then re-pointed
        // containerFile at that raw image. Decompressing AGAIN here would feed
        // raw XFS bytes to zstd → "Unknown frame descriptor" (the restore
        // failure seen on EC2: a wasted ~4m decompress that then fell back to a
        // cold install). Detect that case and mount the raw image directly.
        // shouldCopyOnRwRestore() then handles the copy + UUID randomize so we
        // never RW-mount the shared WORM source in place.
        if (this.isInNodeLocalDir()) {
            this.logInfo(
                "Container file is the raw node-local WORM image — skipping decompress (already raw)"
            );
            this.rawImageFile = this.containerFile;
            this.xfsImage.setImageFile(this.rawImageFile);
            return;
        }
        await this.decompressToRaw(this.containerFile, this.rawImageFile);
        this.xfsImage.setImageFile(this.rawImageFile);
    }

    /**
     * When containerFile points at the raw image in the node-local WORM dir
     * (S3-download → commit → re-point), the RW restore must copy +
     * UUID-randomize before mounting so we never mutate the shared WORM source
     * and never collide UUIDs with another runner on the same node. Mirrors
     * btrfs's node-local RW behaviour.
     */
    protected shouldCopyOnRwRestore(): boolean {
        return this.isInNodeLocalDir();
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
            `Compressing raw XFS image with lz4: ${rawFile} → ${archive}`
        );
        // Codec is lz4, NOT zstd. The restore-side bottleneck is DECOMPRESSION,
        // not download: the raw image is a ~25G sparse XFS whose decompress must
        // materialize ~8-12G of real blocks. zstd `-d` of a single-frame stream
        // is single-threaded, so it pinned one core for ~200s (measured: 82% of
        // jobs take the S3 path at ~215s avg). lz4 decompresses several times
        // faster (GB/s class) for a ~1.5x larger artifact — and since S3→EKS is
        // intra-region ($0 egress) the extra bytes are effectively free, while
        // the larger artifact also stages FASTER on the prewarm DaemonSet
        // (download-bound, not CPU-bound) and the producer's cold-boot save is
        // cheaper too. Source is KEPT (`-k`) so the node-local commit can still
        // copy the RAW image afterwards.
        //
        // NOTE: NO `-T0` — lz4 multithread flag support varies across versions
        // (runner images ship lz4 1.9.x vs 1.10.x); `-T0` made lz4 exit 1 on an
        // older build. Compression is not the bottleneck here (decompress is),
        // and single-threaded lz4 already runs at GB/s, so dropping the flag
        // costs nothing and works on every lz4 build.
        await exec.exec("lz4", ["-f", "-k", rawFile, archive], {
            cwd: this.safeCwd,
            silent: !core.isDebug()
        });

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
        // Detect the codec by MAGIC BYTES rather than assuming one, so a cache
        // artifact written by either codec restores correctly. This matters
        // across the lz4-cutover: images saved by an older producer are zstd,
        // newer ones are lz4, and both can be live under different keys until
        // the cache key next rotates. Magic: zstd = 28 B5 2F FD, lz4 = 04 22 4D 18.
        const codec = await this.detectArchiveCodec(archive);
        this.logInfo(
            `Decompressing artifact with ${codec} --sparse: ${archive} → ${rawFile}`
        );
        // `--sparse` is the fix for the ~4-min restore: the raw XFS image is a
        // sparse 25G file whose holes compress to near-nothing, but a streaming
        // decompress would re-materialize all 25G as REAL bytes (incl. gigabytes
        // of zeros) → a 25G disk write every restore. Sparse decompress detects
        // zero-runs and seeks over them, so only the ~8-12G of actual data
        // blocks touch disk. `-f` overwrites any stale temp.
        if (codec === "lz4") {
            // lz4 writes sparse by default when the output is a regular file;
            // `--sparse` is accepted explicitly for clarity/forward-compat.
            await exec.exec("lz4", ["-d", "--sparse", "-f", archive, rawFile], {
                cwd: this.safeCwd,
                silent: !core.isDebug()
            });
        } else {
            await exec.exec(
                "zstd",
                ["-d", "--sparse", "-f", "-o", rawFile, archive],
                { cwd: this.safeCwd, silent: !core.isDebug() }
            );
        }
    }

    /**
     * Sniff the compression codec of a cache artifact by its 4-byte magic
     * number: lz4 frame = 04 22 4D 18, zstd frame = 28 B5 2F FD. Defaults to
     * zstd on any read/unknown result (the pre-lz4 codec), so a corrupt or
     * truncated header fails in the same place it always did rather than
     * silently mis-routing.
     */
    private async detectArchiveCodec(archive: string): Promise<"lz4" | "zstd"> {
        try {
            const fh = await fs.open(archive, "r");
            try {
                const buf = Buffer.alloc(4);
                await fh.read(buf, 0, 4, 0);
                if (buf.readUInt32LE(0) === 0x184d2204) return "lz4";
                if (buf.readUInt32LE(0) === 0xfd2fb528) return "zstd";
            } finally {
                await fh.close();
            }
        } catch (err) {
            core.debug(
                `${this.getLogPrefix()} codec sniff failed (${
                    err instanceof Error ? err.message : err
                }); defaulting to zstd`
            );
        }
        return "zstd";
    }
}
