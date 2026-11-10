import { saveGeneratedFile } from '@platform';
import { bytesToBase64 } from '../../../shared/assets/assets';
import { DATA_PACKAGE_LIMITS } from '../../../shared/packages/data-package';
import { request } from './api';
import type { DataPackageExportInput } from '../../../shared/models/export-preflight';

export interface DataPackageDownload {
  filename: string;
  mimeType: 'application/zip';
  dataBase64: string;
  byteLength: number;
}

/** Dispatch hint only, never import authority: generated packages keep their
 * small STORE manifest first, so a large SQLite file need not enter Base64. */
async function sqliteManifestHint(file: File): Promise<boolean> {
  try {
    const bytes = new Uint8Array(await file.slice(0, 30).arrayBuffer());
    if (bytes.length < 30) return false;
    const view = new DataView(bytes.buffer);
    if (view.getUint32(0, true) !== 0x04034b50 || view.getUint16(8, true) !== 0) return false;
    const length = view.getUint32(18, true), nameLength = view.getUint16(26, true), extraLength = view.getUint16(28, true);
    if (length > DATA_PACKAGE_LIMITS.maxManifestBytes || nameLength > 1024) return false;
    const header = 30 + nameLength + extraLength;
    const name = new TextDecoder().decode(await file.slice(30, 30 + nameLength).arrayBuffer());
    if (name !== 'manifest.json') return false;
    const manifest = JSON.parse(await file.slice(header, header + length).text());
    return manifest.format === 'noetic-atlas-package' && manifest.kind === 'sqlite-backup';
  } catch { return false; }
}

export async function readPackageFile(file: File): Promise<string> {
  if (await sqliteManifestHint(file)) throw new Error('这是SQLite完整数据库备份包，请前往完整数据库恢复入口；本页不会上传或合并数据库。');
  if (file.size > DATA_PACKAGE_LIMITS.maxBytes)
    throw new Error('数据包超过允许大小。完整数据库备份请使用 SQLite 数据包恢复入口。');
  if (!file.size) throw new Error('数据包是空文件。');
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

export async function savePackageDownload(file: DataPackageDownload): Promise<void> {
  if (file.mimeType !== 'application/zip' || !Number.isSafeInteger(file.byteLength) || file.byteLength <= 0 || file.byteLength > DATA_PACKAGE_LIMITS.maxBytes)
    throw new Error('服务器返回的数据包大小或格式无效，请重新生成。');
  if (file.dataBase64.length !== Math.ceil(file.byteLength / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64))
    throw new Error('数据包下载不完整，请重新生成。');
  const bytes = new Uint8Array(file.byteLength);
  let offset = 0;
  for (let i = 0; i < file.dataBase64.length; i += 32768) {
    const block = atob(file.dataBase64.slice(i, i + 32768));
    if (offset + block.length > bytes.length) throw new Error('数据包大小与声明不一致。');
    for (let cursor = 0; cursor < block.length; cursor++) bytes[offset++] = block.charCodeAt(cursor);
  }
  if (offset !== bytes.length || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('数据包不是完整 ZIP 文件。');
  const filename = file.filename.replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 140);
  await saveGeneratedFile(filename.toLowerCase().endsWith('.zip') ? filename : `${filename || '认知星图-数据包'}.zip`, bytes, 'application/zip');
}

export async function exportPackage(input: DataPackageExportInput, signal?: AbortSignal): Promise<void> {
  // The server rechecks the same budget before collecting export bodies.
  const file = await request<DataPackageDownload>('/api/packages/export', { method: 'POST', body: JSON.stringify(input), signal });
  signal?.throwIfAborted();
  await savePackageDownload(file);
}
