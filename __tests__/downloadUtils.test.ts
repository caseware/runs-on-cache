import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { downloadCacheHttpClientConcurrent } from "../src/custom/downloadUtils";

jest.mock("@actions/core", () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    isDebug: jest.fn(() => false),
    setFailed: jest.fn()
}));

// retryHttpClientResponse only adds retry/backoff around the request; the tests drive the
// failure modes through the HttpClient mock instead.
jest.mock("@actions/cache/lib/internal/requestUtils", () => ({
    retryHttpClientResponse: jest.fn(
        async (_name: string, method: () => Promise<unknown>) => await method()
    )
}));

const ARCHIVE_SIZE = 40;
const PART_SIZE = 16;
const CONTENT = Buffer.from(
    Array.from({ length: ARCHIVE_SIZE }, (_, i) => i % 251)
);

/** Parses a `bytes=<start>-<end>` Range header into an inclusive tuple. */
function parseRange(range: string): [number, number] {
    const match = /bytes=(\d+)-(\d+)/.exec(range);
    if (!match) throw new Error(`unexpected range header: ${range}`);
    return [Number(match[1]), Number(match[2])];
}

interface SegmentResponse {
    message: { headers: Record<string, string> };
    readBodyBuffer: () => Promise<Buffer>;
}

/**
 * Minimal HttpClient stub.
 *
 * `truncateOffsets` drops bytes off the end of the body for a given offset, for a given number
 * of attempts, reproducing a short ranged GET. `replacedTotalFrom` makes every segment from that
 * offset onwards report a different object size in its Content-Range, reproducing the cache key
 * being re-saved while the download is in flight.
 */
function createHttpClientMock(options: {
    truncateOffsets?: Map<number, { bytes: number; times: number }>;
    replacedTotalFrom?: { offset: number; total: number };
}): { get: jest.Mock; request: jest.Mock; dispose: jest.Mock } {
    const truncateOffsets = options.truncateOffsets ?? new Map();
    const replaced = options.replacedTotalFrom;
    return {
        request: jest.fn(async () => ({
            message: {
                headers: {
                    "content-range": `bytes 0-1/${ARCHIVE_SIZE}`
                }
            }
        })),
        get: jest.fn(
            async (
                _url: string,
                headers: { Range: string }
            ): Promise<SegmentResponse> => {
                const [start, end] = parseRange(headers.Range);
                let body = CONTENT.subarray(start, end + 1);
                const truncation = truncateOffsets.get(start);
                if (truncation && truncation.times > 0) {
                    truncation.times--;
                    body = body.subarray(0, body.byteLength - truncation.bytes);
                }
                const total =
                    replaced && start >= replaced.offset
                        ? replaced.total
                        : ARCHIVE_SIZE;
                return {
                    message: {
                        headers: {
                            "content-range": `bytes ${start}-${end}/${total}`
                        }
                    },
                    readBodyBuffer: async () => body
                };
            }
        ),
        dispose: jest.fn()
    };
}

const httpClientMock = { current: createHttpClientMock({}) };

jest.mock("@actions/http-client", () => ({
    HttpClient: jest.fn(() => httpClientMock.current)
}));

describe("downloadCacheHttpClientConcurrent", () => {
    let tempDir: string;
    let archivePath: string;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dl-test-"));
        archivePath = path.join(tempDir, "cache.tar.lz4");
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("writes the complete archive when every segment returns in full", async () => {
        httpClientMock.current = createHttpClientMock({});

        await downloadCacheHttpClientConcurrent(
            "https://example.test/cache",
            archivePath,
            {
                partSize: PART_SIZE,
                concurrentBlobDownloads: true,
                downloadConcurrency: 2,
                timeoutInMs: 30000
            }
        );

        expect(await fs.readFile(archivePath)).toEqual(CONTENT);
    });

    it("retries a short segment and still writes the complete archive", async () => {
        // The middle segment comes back 5 bytes short on its first attempt only.
        httpClientMock.current = createHttpClientMock({
            truncateOffsets: new Map([[PART_SIZE, { bytes: 5, times: 1 }]])
        });

        await downloadCacheHttpClientConcurrent(
            "https://example.test/cache",
            archivePath,
            {
                partSize: PART_SIZE,
                concurrentBlobDownloads: true,
                downloadConcurrency: 2,
                timeoutInMs: 30000
            }
        );

        expect(await fs.readFile(archivePath)).toEqual(CONTENT);
        // Three segments, one of which was fetched twice.
        expect(httpClientMock.current.get).toHaveBeenCalledTimes(4);
    });

    it("fails instead of writing a corrupt archive when a segment stays short", async () => {
        httpClientMock.current = createHttpClientMock({
            truncateOffsets: new Map([
                [PART_SIZE, { bytes: 5, times: Number.MAX_SAFE_INTEGER }]
            ])
        });

        await expect(
            downloadCacheHttpClientConcurrent(
                "https://example.test/cache",
                archivePath,
                {
                    partSize: PART_SIZE,
                    concurrentBlobDownloads: true,
                    downloadConcurrency: 2,
                    timeoutInMs: 30000
                }
            )
        ).rejects.toThrow(/is 11 bytes, expected 16/);

        // The offset that keeps coming back short is retried, not attempted once.
        const attemptsForBadOffset =
            httpClientMock.current.get.mock.calls.filter(
                ([, headers]: [string, { Range: string }]) =>
                    headers.Range.startsWith(`bytes=${PART_SIZE}-`)
            ).length;
        expect(attemptsForBadOffset).toBeGreaterThan(1);
    });

    it("fails fast when the archive is replaced mid-download", async () => {
        // From the second segment onwards the object reports a different total size, which is
        // what S3 does once the cache key has been re-saved under the download's feet.
        httpClientMock.current = createHttpClientMock({
            replacedTotalFrom: { offset: PART_SIZE, total: ARCHIVE_SIZE - 4 }
        });

        await expect(
            downloadCacheHttpClientConcurrent(
                "https://example.test/cache",
                archivePath,
                {
                    partSize: PART_SIZE,
                    concurrentBlobDownloads: true,
                    downloadConcurrency: 1,
                    timeoutInMs: 30000
                }
            )
        ).rejects.toThrow(/changed while it was being downloaded/);

        // A replaced archive is permanent, so the range is requested once, not six times.
        const attemptsForChangedOffset =
            httpClientMock.current.get.mock.calls.filter(
                ([, headers]: [string, { Range: string }]) =>
                    headers.Range.startsWith(`bytes=${PART_SIZE}-`)
            ).length;
        expect(attemptsForChangedOffset).toBe(1);
    });
});
