import { Directory, Filesystem } from '@capacitor/filesystem';
import { registerPlugin } from '@capacitor/core';
import { generatedFileBytes, generatedFileName } from '../shared/assets/generated-file';
import { bytesToBase64 } from './storage';

interface FileShare { share(options: { uri: string; mimeType: string; title: string }): Promise<void> }
const FileSharePlugin = registerPlugin<FileShare>('LearningFileShare');

export function createGeneratedFileSaver(filesystem: Pick<typeof Filesystem, 'writeFile'> = Filesystem, share: FileShare = FileSharePlugin) {
  return async (filename: string, value: Uint8Array | Blob, mimeType: string): Promise<void> => {
    const normalized = generatedFileName(filename, mimeType);
    const bytes = await generatedFileBytes(value);
    // Each share gets its own copy, so a later export cannot overwrite bytes
    // an already-open receiving application is still reading.
    const path = `exports/${crypto.randomUUID()}/${normalized.filename}`;
    const file = await filesystem.writeFile({ directory: Directory.Cache, path, data: bytesToBase64(bytes), recursive: true });
    await share.share({ uri: file.uri, mimeType: normalized.mimeType, title: normalized.filename });
  };
}
export const saveGeneratedFile = createGeneratedFileSaver();
