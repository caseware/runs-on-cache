export enum Inputs {
    Key = "key", // Input for cache, restore, save action
    Path = "path", // Input for cache, restore, save action
    RestoreKeys = "restore-keys", // Input for cache, restore action
    UploadChunkSize = "upload-chunk-size", // Input for cache, save action
    EnableCrossOsArchive = "enableCrossOsArchive", // Input for cache, restore, save action
    FailOnCacheMiss = "fail-on-cache-miss", // Input for cache, restore action
    ForceSave = "force-save", // Input for cache
    LookupOnly = "lookup-only", // Input for cache, restore action

    CustomCompression = "custom-compression", // Input for cache, save action
    CustomCompressionLevel = "custom-compression-level", // Input for cache, save action
    ContainerFormat = "container-format", // Input for cache, save action (tar, btrfs)
    Sync = "sync", // Input for cache, save action
    FsSize = "fs-size", // Input for btrfs filesystem size
    FsBufferMB = "fs-buffer-mb", // Input for btrfs filesystem buffer size
    SaveCompressionLevel = "save-compression-level", // Input for btrfs defrag compression before upload
    NodeLocalCacheDir = "node-local-cache-dir", // Input for node-local persistent cache directory (HostPath mount)
    MountMode = "mount-mode", // Input for mount mode: "ro" (read-only, default for node_modules) or "rw" (read-write, for mutable caches)
    FailOnSaveError = "fail-on-save-error", // Input for failing the action on save errors (useful for cache validation tests)
    CleanupNodeLocal = "cleanup-node-local", // Input for node-local image cleanup policy: "none" | "stale" (default) | "always"
    SkipRestore = "skip-restore", // Input: skip node-local + S3 restore and create a fresh empty image (producer/force-rebuild — never mount a stale/corrupt cached image)
    OverlayUpperSize = "overlay-upper-size" // Input: size (e.g. "4G") of the per-job ext4 loop image backing a consumer overlay's RW upper (fallocate-full → O(1) teardown). Empty => plain-dir upper. Pass a fraction of the runner's ephemeral-storage.
}

export enum Outputs {
    CacheHit = "cache-hit", // Output from cache, restore action
    CachePrimaryKey = "cache-primary-key", // Output from restore action
    CacheMatchedKey = "cache-matched-key", // Output from restore action
    NodeLocalCacheHit = "node-local-cache-hit", // Output from restore action: "true" | "false" | "disabled"
    // Output from restore action: precise provenance of the restored image.
    //   prewarmed  : node-local hostPath hit on a DaemonSet-prestaged image
    //                (carries the prewarm stamp file)
    //   node-local : node-local hostPath hit on an image left by a prior runner
    //                on this node (no prewarm stamp)
    //   s3         : downloaded from the S3 bucket (node-local missed)
    //   cold-boot  : no cache found (empty image created)
    CacheSource = "cache-source"
}

export enum State {
    CachePrimaryKey = "CACHE_KEY",
    CacheMatchedKey = "CACHE_RESULT"
}

export enum Events {
    Key = "GITHUB_EVENT_NAME",
    Push = "push",
    PullRequest = "pull_request"
}

export const RefKey = "GITHUB_REF";
