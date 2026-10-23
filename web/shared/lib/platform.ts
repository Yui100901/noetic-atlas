// The ordinary web build keeps HTTP semantics and never loads native modules.
import { generatedFileBytes, generatedFileName } from '../../../shared/assets/generated-file';
export const isNativeApp = () => false;
export async function nativeFetch(_url: string, _options: RequestInit): Promise<Response> { throw new Error('当前为网页模式'); }
export async function nativeDownload(_url: string, _filename?: string): Promise<void> { throw new Error('当前为网页模式'); }
export async function saveGeneratedFile(filename: string, value: Uint8Array | Blob, mimeType: string): Promise<void> {
  const normalized = generatedFileName(filename, mimeType);
  const bytes = await generatedFileBytes(value);
  const blob = new Blob([new Uint8Array(bytes).buffer], { type: normalized.mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = objectUrl; link.download = normalized.filename;
  document.body.appendChild(link); link.click(); link.remove();
  // Browsers may start consuming the Blob after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
