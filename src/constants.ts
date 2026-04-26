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
    PreviousVersionMount = "previous-version-mount" // When true, mount the closest partial-hit image read-only at a secondary path (git alternates pattern)
}

export enum Outputs {
    CacheHit = "cache-hit", // Output from cache, restore action
    CachePrimaryKey = "cache-primary-key", // Output from restore action
    CacheMatchedKey = "cache-matched-key", // Output from restore action
    NodeLocalCacheHit = "node-local-cache-hit", // Output from restore action: "true" | "false" | "disabled"
    PreviousVersionPath = "previous-version-path" // Output from restore action: path to the RO-mounted previous version (empty if not applicable)
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
