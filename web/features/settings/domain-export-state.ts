import type {
  ContentExportFile,
  ContentExportPurpose,
  ContentExportScope,
} from '../../../shared/models/domain-exports';
import { isBase64Text } from '../../../shared/assets/assets';

export function contentExportDefaults(
  purpose: ContentExportPurpose,
): Pick<ContentExportScope, 'purpose' | 'status' | 'collection'> {
  return purpose === 'share'
    ? { purpose, status: 'published', collection: 'general' }
    : { purpose, status: 'all', collection: 'all' };
}

/** Selection identity excludes display order, so a late response cannot apply to a different export. */
export function contentExportKey(scope: ContentExportScope): string {
  return JSON.stringify({ ...scope, domainIds: [...new Set(scope.domainIds)].sort() });
}

export function exportFileBytes(file: ContentExportFile, maximum: number): Uint8Array<ArrayBuffer> {
  const length = file.byteLength;
  if (!Number.isSafeInteger(length) || length <= 0 || length > maximum)
    throw new Error('导出文件超过允许大小，或文件大小无效。请减少所选领域后重试。');
  const encoded = file.dataBase64;
  if (
    typeof encoded !== 'string' ||
    encoded.length !== Math.ceil(length / 3) * 4 ||
    !isBase64Text(encoded)
  )
    throw new Error('导出文件不完整，请重新生成。');
  const bytes = new Uint8Array(length);
  let offset = 0;
  // Decode bounded blocks to avoid a second full-size binary string on mobile.
  for (let index = 0; index < encoded.length; index += 32_768) {
    const block = atob(encoded.slice(index, index + 32_768));
    if (offset + block.length > length) throw new Error('导出文件大小与声明不一致，请重新生成。');
    for (let cursor = 0; cursor < block.length; cursor++)
      bytes[offset++] = block.charCodeAt(cursor);
  }
  if (offset !== length) throw new Error('导出文件大小与声明不一致，请重新生成。');
  return bytes;
}

export function portableExportFilename(
  filename: string,
  mimeType: ContentExportFile['mimeType'],
): string {
  const extension = mimeType === 'application/zip' ? '.zip' : '.json';
  const basename = filename
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 140);
  const name = basename || '认知星图-题库导出';
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

export function readableExportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
