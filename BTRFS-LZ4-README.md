# BTRFS-LZ4 Cache Format (Linux Only)

This action supports a new custom compression format `btrfs-lz4` that combines BTRFS filesystem with LZ4 compression for efficient caching.

> **⚠️ Important: Linux Only**  
> The `btrfs-lz4` format is only supported on Linux runners. The action will automatically detect the platform and fail with a clear error message if used on other platforms. For cross-platform compatibility, use standard compression formats like `lz4`, `gzip`, or `zstd`.

## Overview

The `btrfs-lz4` format creates a BTRFS filesystem image containing your cache data, then compresses it with LZ4. This provides several advantages:

- **Efficient storage**: BTRFS provides built-in deduplication and efficient file storage
- **Fast compression**: LZ4 offers excellent compression speed with reasonable compression ratios  
- **Atomic operations**: Complete filesystem images ensure cache consistency
- **Linux optimized**: Designed specifically for Linux environments with BTRFS support

## Usage

### Basic Usage

```yaml
- uses: ./s3cache/restore
  with:
    path: ./node_modules
    key: Linux-aarch64-node-20.17-self-hosted-nodemodules-${{ hashFiles('package-lock.json') }}
    custom-compression: btrfs-lz4
    fs-size: 50G
```

### Configuration Options

- `custom-compression: btrfs-lz4` - Enables BTRFS-LZ4 compression format (Linux only)
- `fs-size: 50G` - Sets the initial filesystem size (default: 50G)
  - Supports sizes like: `1G`, `5G`, `50G`, `100G`, etc.
  - The filesystem will be automatically resized to the minimum required size plus buffer
- `fs-buffer-mb: 2048` - Sets the free space to add as a buffer after file system shrinking (default 2048)

## Requirements (Linux Only)

> **Platform Requirement**: This format only works on Linux systems. Attempting to use it on other platforms will result in an error.

The BTRFS-LZ4 format requires the following tools to be available on the Linux runner:

- `truncate` - For creating sparse files
- `mkfs.btrfs` - For creating BTRFS filesystems (part of btrfs-progs)
- `btrfs` - For filesystem operations (part of btrfs-progs)
- `lz4` - For compression
- `sudo` access - Required for filesystem mounting operations

### Installing Dependencies

#### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install btrfs-progs lz4
```

#### CentOS/RHEL/Fedora
```bash
sudo dnf install btrfs-progs lz4
# or on older systems:
sudo yum install btrfs-progs lz4
```

## How It Works

### Save Process

1. Creates a sparse BTRFS filesystem image of the specified size
2. Mounts the image as a loopback device
3. Copies cache contents into the mounted filesystem
4. Optimizes the filesystem (balance operation)
5. Resizes the filesystem to minimum required size + buffer
6. Unmounts and truncates the image to actual size
7. Compresses the image with LZ4
8. Uploads the compressed image to S3

### Restore Process

1. Downloads the compressed BTRFS image from S3
2. Decompresses the image with LZ4
3. Mounts the image as read-only loopback device
4. Copies contents from mounted filesystem to cache paths
5. Unmounts and cleans up temporary files

## Performance Considerations

- **Initial filesystem size**: Set `fs-size` (default 50GB) large enough to accommodate your cache data to avoid filesystem resize operations. The image is lazily-allocated, so setting the fs-size larger than necessary should not be an issue.
- **Buffer size**: Set `fs-buffer-mb` (default 2048) large enough to accomodate for btrfs metadata. The LZ4 compression usually makes this buffer a non-issue.
- **Compression speed**: LZ4 is optimized for speed over compression ratio
- **Network transfer**: Smaller compressed images reduce download/upload times
