import { Inflate } from 'fflate';
import { crc32 } from '../exports/zip.js';
import {
  DataPackageError,
  packageError,
  packagePathIsSafe,
  type DataPackageLimits,
} from './schema.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
function archiveFilename(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return packageError('ZIP文件名必须为UTF-8');
  }
}

/** Parse central records before allocation. No extraction to filesystem or network. */
export function readPackageArchive(
  bytes: Uint8Array,
  limits: DataPackageLimits,
): Map<string, Uint8Array> {
  if (bytes.length < 22 || bytes.length > limits.maxBytes)
    packageError('请选择有效ZIP数据包，或缩小包的大小');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const earliestEnd = Math.max(0, bytes.length - 65557);
  let end = bytes.length - 22;
  // A ZIP comment may itself contain the signature. Its declared length must
  // reach EOF before treating a candidate as the end-of-directory record.
  while (
    end >= earliestEnd &&
    (view.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + view.getUint16(end + 20, true) !== bytes.length)
  )
    end--;
  if (end < earliestEnd) packageError('ZIP目录缺失或文件已损坏');
  if (
    end + 22 + view.getUint16(end + 20, true) !== bytes.length ||
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true)
  )
    packageError('不支持分卷ZIP或损坏的ZIP尾部');
  const count = view.getUint16(end + 10, true),
    central = view.getUint32(end + 16, true);
  if (
    count !== view.getUint16(end + 8, true) ||
    count === 65535 ||
    count > limits.maxFiles + 1 ||
    central + view.getUint32(end + 12, true) !== end
  )
    packageError('ZIP目录数量或范围无效');
  const records: Array<{
    path: string;
    offset: number;
    start: number;
    end: number;
    size: number;
    expanded: number;
    crc: number;
    method: number;
    directory: boolean;
  }> = [];
  let cursor = central,
    total = 0;
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      packageError('ZIP中央目录已损坏');
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true);
    const size = view.getUint32(cursor + 20, true),
      expanded = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true),
      crc = view.getUint32(cursor + 16, true);
    if (
      cursor + 46 + nameLength + extra + comment > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      view.getUint16(cursor + 34, true) ||
      ((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000
    )
      packageError('ZIP加密、压缩方式、链接或分卷不受支持');
    const path = archiveFilename(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const directory = path.endsWith('/');
    if (!packagePathIsSafe(directory ? path.slice(0, -1) : path) || names.has(path.toLowerCase()))
      packageError('ZIP路径无效或重复');
    names.add(path.toLowerCase());
    if (
      expanded > (path === 'manifest.json' ? limits.maxManifestBytes : limits.maxFileBytes) ||
      (total += expanded) > limits.maxExpandedBytes + limits.maxManifestBytes
    )
      packageError('ZIP解压大小超过限制');
    if (
      offset + 30 > central ||
      view.getUint32(offset, true) !== 0x04034b50 ||
      view.getUint16(offset + 6, true) !== flags ||
      view.getUint16(offset + 8, true) !== method
    )
      packageError('ZIP本地目录与中央目录不一致');
    const localName = view.getUint16(offset + 26, true),
      localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    if (
      start + size > central ||
      archiveFilename(bytes.subarray(offset + 30, offset + 30 + localName)) !== path
    )
      packageError('ZIP文件内容越界或文件名冲突');
    if (
      !(flags & 8) &&
      (view.getUint32(offset + 14, true) !== crc ||
        view.getUint32(offset + 18, true) !== size ||
        view.getUint32(offset + 22, true) !== expanded)
    )
      packageError('ZIP本地长度或CRC不一致');
    let recordEnd = start + size;
    if (flags & 8) {
      const descriptorMatches = (at: number) =>
        at + 12 <= central &&
        view.getUint32(at, true) === crc &&
        view.getUint32(at + 4, true) === size &&
        view.getUint32(at + 8, true) === expanded;
      if (
        recordEnd + 4 <= central &&
        view.getUint32(recordEnd, true) === 0x08074b50 &&
        descriptorMatches(recordEnd + 4)
      )
        recordEnd += 16;
      else if (descriptorMatches(recordEnd)) recordEnd += 12;
      else packageError('ZIP数据描述符缺失或与中央目录不一致');
    }
    if (directory && expanded) packageError('ZIP目录条目不应包含内容');
    records.push({ path, offset, start, end: recordEnd, size, expanded, crc, method, directory });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) packageError('ZIP中央目录边界不一致');
  const byOffset = [...records].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < byOffset.length; i++)
    if (byOffset[i]!.offset < byOffset[i - 1]!.end) packageError('ZIP文件区域重叠');
  const result = new Map<string, Uint8Array>();
  for (const record of records) {
    const compressed = bytes.subarray(record.start, record.start + record.size);
    let output: Uint8Array;
    if (record.method === 0) output = compressed;
    else {
      output = new Uint8Array(record.expanded);
      let used = 0;
      const inflater = new Inflate((chunk) => {
        if (used + chunk.length > record.expanded)
          packageError('ZIP实际解压量超出声明，已停止处理');
        output.set(chunk, used);
        used += chunk.length;
      });
      try {
        for (let n = 0; n < compressed.length; n += 4096)
          inflater.push(compressed.subarray(n, n + 4096), n + 4096 >= compressed.length);
        if (!compressed.length) inflater.push(compressed, true);
      } catch (reason) {
        if (reason instanceof DataPackageError) throw reason;
        packageError(`ZIP文件解压失败：${record.path}`);
      }
      if (used !== record.expanded) packageError('ZIP解压长度与目录声明不一致');
    }
    if (output.length !== record.expanded || crc32(output) !== record.crc)
      packageError(`ZIP长度或CRC校验失败：${record.path}`);
    if (!record.directory) result.set(record.path, output);
  }
  return result;
}
