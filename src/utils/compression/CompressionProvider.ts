export interface CompressionProvider {
    compress(inputPath: string, outputPath: string): Promise<void>;
    decompress(inputPath: string, outputPath: string): Promise<void>;
    getExtension(): string;
}