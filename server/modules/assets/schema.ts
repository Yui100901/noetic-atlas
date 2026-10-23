import { z } from 'zod';
import { assetMimeTypes, base64ToBytes, bytesToBase64, type AssetRecord, type AssetMimeType } from '../../../shared/assets/assets.js';
import { fail, id, parse } from '../../core/validation.js';

export interface AssetLimits { maxDocumentMiB: number; maxImageMiB: number }
export const DEFAULT_ASSET_LIMITS: AssetLimits = { maxDocumentMiB: 20, maxImageMiB: 5 };
const MiB = 1024 * 1024;
export const assetInputSchema = z.object({ filename: z.string().min(1).max(1000), mimeType: z.enum(assetMimeTypes), dataBase64: z.string().min(4).max(140 * MiB) }).strict();
export const assetRecordSchema = assetInputSchema.extend({ id, sizeBytes: z.number().int().positive().max(100 * MiB), createdAt: z.string().datetime({ offset: true }), width: z.number().int().positive().max(16384).optional(), height: z.number().int().positive().max(16384).optional() }).strict();
export function sanitizeAssetFilename(input: string): string {
  const base = input.split(/[\\/]/).at(-1)!.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  return (base || 'attachment').slice(0, 180);
}
export function decodeAssetBase64(value: string): Uint8Array {
  if (value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(400, 'INVALID_ASSET_BASE64', '文件必须使用完整、规范的 Base64 编码，不含 data: 前缀或空白');
  let bytes: Uint8Array;
  try { bytes = base64ToBytes(value); } catch { fail(400, 'INVALID_ASSET_BASE64', '文件 Base64 编码无效'); }
  if (bytesToBase64(bytes!) !== value) fail(400, 'INVALID_ASSET_BASE64', '文件 Base64 编码含无效填充位');
  return bytes!;
}
const starts = (bytes: Uint8Array, signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
function imageDimensions(bytes: Uint8Array, mime: AssetMimeType): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = (): never => fail(400, 'INVALID_ASSET_FILE', '图片格式、文件头或完整性校验失败');
  let width = 0, height = 0;
  if (mime === 'image/png') {
    if (bytes.length < 45 || !starts(bytes, [137,80,78,71,13,10,26,10]) || ascii(bytes, 12, 16) !== 'IHDR' || view.getUint32(8) !== 13) invalid();
    width = view.getUint32(16); height = view.getUint32(20);
    let offset = 8, ended = false, hasData = false;
    while (offset + 12 <= bytes.length) { const length = view.getUint32(offset); if (length > bytes.length - offset - 12) invalid(); const type = ascii(bytes, offset + 4, offset + 8); if (type === 'IDAT') hasData = true; offset += length + 12; if (type === 'IEND') { if (length !== 0 || offset !== bytes.length) invalid(); ended = true; break; } }
    if (!ended || !hasData) invalid();
  } else if (mime === 'image/jpeg') {
    if (bytes.length < 10 || !starts(bytes, [255,216]) || !starts(bytes, [255,217], bytes.length - 2)) invalid();
    let offset = 2;
    while (offset + 4 <= bytes.length) { if (bytes[offset++] !== 255) invalid(); while (bytes[offset] === 255) offset++; const marker = bytes[offset++]!; if (marker === 217 || marker === 218) break; if (marker === 1 || marker >= 208 && marker <= 215) continue; if (offset + 2 > bytes.length) invalid(); const length = view.getUint16(offset); if (length < 2 || offset + length > bytes.length) invalid(); if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { if (length < 8) invalid(); height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break; } offset += length; }
  } else if (mime === 'image/gif') {
    if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)) || bytes.at(-1) !== 59) invalid(); width = view.getUint16(6, true); height = view.getUint16(8, true);
  } else if (mime === 'image/webp') {
    if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) invalid();
    const kind = ascii(bytes, 12, 16); const chunkSize = view.getUint32(16, true); if (20 + chunkSize > bytes.length) invalid();
    if (kind === 'VP8X' && chunkSize >= 10) { width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16); height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16); }
    else if (kind === 'VP8 ' && chunkSize >= 10 && starts(bytes, [157,1,42], 23)) { width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff; }
    else if (kind === 'VP8L' && chunkSize >= 5 && bytes[20] === 47) { const bits = view.getUint32(21, true); width = (bits & 0x3fff) + 1; height = (bits >>> 14 & 0x3fff) + 1; }
    else invalid();
  }
  if (!width || !height || width > 16384 || height > 16384 || width * height > 40_000_000) fail(400, 'IMAGE_DIMENSIONS_EXCEEDED', '图片须在16384像素及4000万像素以内，请先压缩图片');
  return { width, height };
}
export function validateAssetBytes(bytes: Uint8Array, mimeType: AssetMimeType, limits: AssetLimits = DEFAULT_ASSET_LIMITS): { width?: number; height?: number } {
  const image = mimeType.startsWith('image/'); const maximum = (image ? limits.maxImageMiB : limits.maxDocumentMiB) * MiB;
  if (!bytes.length || bytes.length > maximum) fail(413, 'ASSET_TOO_LARGE', `${image ? '图片' : '文档'}文件须为1字节至${image ? limits.maxImageMiB : limits.maxDocumentMiB}MiB`);
  if (image) return imageDimensions(bytes, mimeType);
  if (mimeType === 'text/markdown') { try { if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\0')) throw new Error(); } catch { fail(400, 'INVALID_MARKDOWN_ENCODING', 'Markdown 文件须为有效 UTF-8 文本，且不包含空字符'); } }
  if (mimeType === 'application/pdf') {
    const head = ascii(bytes, 0, Math.min(bytes.length, 16)); const tail = ascii(bytes, Math.max(0, bytes.length - 2048), bytes.length);
    if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n|\s)/.test(head) || !/%%EOF[\x00\t\n\r ]*$/.test(tail) || !/startxref\s+\d+\s+%%EOF[\x00\t\n\r ]*$/.test(tail)) fail(400, 'INVALID_ASSET_FILE', 'PDF 文件头、交叉引用或文件结束标记无效');
    const text = new TextDecoder('latin1').decode(bytes); if (!/\d+\s+\d+\s+obj\b/.test(text) || !/\/(?:Type\s*\/Catalog|Root\s+\d+\s+\d+\s+R)\b/.test(text)) fail(400, 'INVALID_ASSET_FILE', 'PDF 缺少有效文档对象');
    const pointer = Number(/startxref\s+(\d+)\s+%%EOF[\x00\t\n\r ]*$/.exec(tail)?.[1]);
    if (!Number.isSafeInteger(pointer) || pointer < 8 || pointer >= bytes.length || !/^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(ascii(bytes, pointer, Math.min(pointer + 80, bytes.length)))) fail(400, 'INVALID_ASSET_FILE', 'PDF 交叉引用位置无效');
  }
  return {};
}
export function validateAssetRecord(value: unknown, limits: AssetLimits = { maxDocumentMiB: 100, maxImageMiB: 100 }): AssetRecord {
  const record = parse(assetRecordSchema, value); const bytes = decodeAssetBase64(record.dataBase64); const dimensions = validateAssetBytes(bytes, record.mimeType, limits);
  if (record.sizeBytes !== bytes.length || record.width !== dimensions.width || record.height !== dimensions.height) fail(400, 'INVALID_ASSET_METADATA', '文件大小或图片尺寸与内容不一致');
  if (sanitizeAssetFilename(record.filename) !== record.filename) fail(400, 'INVALID_ASSET_FILENAME', '文件名含不允许的路径或字符');
  return record;
}
