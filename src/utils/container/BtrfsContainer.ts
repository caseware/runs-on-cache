/**
 * BtrfsContainer — thin BTRFS-specific orchestrator.
 *
 * All fs-agnostic orchestration (bind mounts, node-local hot path, copy+UUID
 * WORM flow, mount discovery, unmount, cleanup, path-traversal) lives in
 * LoopContainer. This class supplies only the BTRFS specifics: the BtrfsImage
 * instance, the ".btrfs" node-local extension, isSupportedMethod, the "[BTRFS]"
 * log prefix, the findmnt fs-type, and the WORM-dir copy-on-RW-restore rule.
 *
 * BTRFS uses transparent in-filesystem compression, so there is NO explicit
 * compress/decompress around the S3 round-trip — the raw image IS the artifact
 * (the base's finalizeSaveArtifact / prepareRawForRestore hooks stay no-ops).
 */
import {
    BtrfsImage,
    validateCompressionLevel,
    validateFsSize
} from "./BtrfsImage";
import { ContainerOptions } from "./Container";
import { LoopContainer } from "./LoopContainer";
import { LoopImage } from "./LoopImage";

export class BtrfsContainer extends LoopContainer {
    private readonly btrfsImage: BtrfsImage;

    constructor(
        containerFile: string,
        compressionMethod: string,
        compressionLevel: string | undefined,
        baseDir: string,
        pathsToCache: string[],
        cacheKey: string,
        options: ContainerOptions
    ) {
        if (!compressionLevel) {
            compressionLevel = "zstd:3";
        }

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
        if (this.compressionLevel) {
            validateCompressionLevel(this.compressionLevel);
        }
        const saveCompLevel = options.saveCompressionLevel || "zstd:3";
        validateCompressionLevel(saveCompLevel);

        // BtrfsImage handles all image-level operations.
        // Save buffer: zero — the 50G sparse virtual size gives defrag/recompress
        // all the room it needs. After defrag+sync, resize to exact Device allocated.
        // RW restore headroom: dynamic 80% utilization target (expand after mount).
        this.btrfsImage = new BtrfsImage(containerFile, {
            compressionLevel: this.compressionLevel!,
            saveCompressionLevel: saveCompLevel,
            saveBufferBytes: 0,
            rwUtilizationTarget: 0.8,
            safeCwd: "" // set in initialize()
        });
    }

    protected get image(): LoopImage {
        return this.btrfsImage;
    }

    protected get fsDisplayName(): string {
        return "BTRFS";
    }

    protected getLogPrefix(): string {
        return "[BTRFS]";
    }

    protected tmpPrefix(): string {
        return "btrfs";
    }

    protected nodeLocalExtension(): string {
        return ".btrfs";
    }

    isSupportedMethod(method?: string): boolean {
        return (method?.split("-")[0] || method) === "btrfs";
    }

    protected findmntFsType(): string {
        return "btrfs";
    }

    protected localCopyName(): string {
        return "cache.btrfs";
    }

    /**
     * Keep BtrfsImage.imageFile in sync with Container.containerFile. Without
     * this, node-local S3 download path updates containerFile but the image
     * still points to the original $RUNNER_TEMP path (which doesn't exist when
     * download went to node-local).
     */
    setArchivePath(archivePath: string): void {
        super.setArchivePath(archivePath);
        this.rawImageFile = archivePath;
        this.btrfsImage.setImageFile(archivePath);
    }

    /**
     * On the standard RW restore, when the container file lives in the
     * node-local WORM dir (S3 download → node-local commit), we must copy +
     * randomize UUID before RW mount. Without this, two runners on the same
     * node get exit code 32 (EEXIST) from BTRFS UUID collision.
     */
    protected shouldCopyOnRwRestore(): boolean {
        return this.isInNodeLocalDir();
    }

    /** btrfs uploads the raw image directly, so the copy becomes containerFile. */
    protected onRawImageCopied(localCopy: string): void {
        this.containerFile = localCopy;
        this.btrfsImage.setImageFile(localCopy);
    }
}
