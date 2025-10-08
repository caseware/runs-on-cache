import * as exec from "@actions/exec";
import { CompressionProvider } from "./CompressionProvider";

export class Lz4Compression implements CompressionProvider {
    async compress(inputPath: string, outputPath: string): Promise<void> {
        await exec.exec("lz4", ["--rm", inputPath, outputPath], { silent: true });
    }

    async decompress(inputPath: string, outputPath: string): Promise<void> {
        await exec.exec("lz4", ["-d", "--rm", inputPath, outputPath], { silent: true });
    }

    getExtension(): string {
        return "lz4";
    }
}
