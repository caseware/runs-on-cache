import { Inputs } from "../constants";

// See: https://github.com/actions/toolkit/blob/master/packages/core/src/core.ts#L67
function getInputName(name: string): string {
    return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}

export function setInput(name: string, value: string): void {
    process.env[getInputName(name)] = value;
}

interface CacheInput {
    path: string;
    key: string;
    restoreKeys?: string[];
    enableCrossOsArchive?: boolean;
    failOnCacheMiss?: boolean;
    lookupOnly?: boolean;
    customCompression?: string;
    sync?: boolean;
    fsSize?: string;
    saveCompressionLevel?: string;
}

export function setInputs(input: CacheInput): void {
    setInput(Inputs.Path, input.path);
    setInput(Inputs.Key, input.key);
    input.restoreKeys &&
        setInput(Inputs.RestoreKeys, input.restoreKeys.join("\n"));
    input.enableCrossOsArchive !== undefined &&
        setInput(
            Inputs.EnableCrossOsArchive,
            input.enableCrossOsArchive.toString()
        );
    input.failOnCacheMiss !== undefined &&
        setInput(Inputs.FailOnCacheMiss, input.failOnCacheMiss.toString());
    input.lookupOnly !== undefined &&
        setInput(Inputs.LookupOnly, input.lookupOnly.toString());
    input.customCompression !== undefined &&
        setInput(Inputs.CustomCompression, input.customCompression);
    input.sync !== undefined && setInput(Inputs.Sync, input.sync.toString());
    input.fsSize !== undefined && setInput(Inputs.FsSize, input.fsSize);
    input.saveCompressionLevel !== undefined &&
        setInput(Inputs.SaveCompressionLevel, input.saveCompressionLevel);
}

export function clearInputs(): void {
    delete process.env[getInputName(Inputs.Path)];
    delete process.env[getInputName(Inputs.Key)];
    delete process.env[getInputName(Inputs.RestoreKeys)];
    delete process.env[getInputName(Inputs.UploadChunkSize)];
    delete process.env[getInputName(Inputs.EnableCrossOsArchive)];
    delete process.env[getInputName(Inputs.FailOnCacheMiss)];
    delete process.env[getInputName(Inputs.LookupOnly)];
    delete process.env[getInputName(Inputs.CustomCompression)];
    delete process.env[getInputName(Inputs.Sync)];
    delete process.env[getInputName(Inputs.FsSize)];
    delete process.env[getInputName(Inputs.SaveCompressionLevel)];
}
