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
    readBodyBuffer: () => Promise<Buffer>;
}

/**
 * Minimal HttpClient stub. `truncateFirstAttempt` drops bytes off the end of the given
 * offset's body the first time it is requested, reproducing a short ranged GET.
 */
function createHttpClientMock(options: {
    truncateOffsets?: Map<number, { bytes: number; times: number }>;
}): { get: jest.Mock; request: jest.Mock; dispose: jest.Mock } {
    const truncateOffsets = options.truncateOffsets ?? new Map();
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
                return { readBodyBuffer: async () => body };
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
});
