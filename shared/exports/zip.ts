export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Portable ZIP32 STORE writer: native and web exports use the same UTF-8
 * filenames, CRCs and bounded allocation, without filesystem/zip dependencies. */
export function createStoredZip(entries: readonly ZipEntry[], maxBytes: number): Uint8Array {
  if (entries.length > 65535) throw new Error('ZIP文件数量超过ZIP32上限');
  const names = new Set<string>();
  const prepared = entries.map((entry) => {
    if (
      !entry.name ||
      entry.name.startsWith('/') ||
      entry.name.includes('\\') ||
      /(^|\/)\.\.?($|\/)/.test(entry.name) ||
      /[\u0000-\u001f:]/.test(entry.name) ||
      names.has(entry.name)
    )
      throw new Error('ZIP文件名无效或重复');
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    if (name.byteLength > 65535 || entry.bytes.byteLength > 0xffffffff)
      throw new Error('ZIP条目超过ZIP32上限');
    return { ...entry, nameBytes: name, crc: crc32(entry.bytes) };
  });
  const total = prepared.reduce(
    (sum, entry) =>
      sum + 30 + entry.nameBytes.length + entry.bytes.length + 46 + entry.nameBytes.length,
    22,
  );
  if (!Number.isSafeInteger(total) || total > Math.min(maxBytes, 0xffffffff))
    throw new Error('ZIP包超过大小上限，请分次选择更少领域');
  const output = new Uint8Array(total),
    view = new DataView(output.buffer);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  let offset = 0;
  const positions: number[] = [];
  for (const entry of prepared) {
    positions.push(offset);
    u32(offset, 0x04034b50);
    u16(offset + 4, 20);
    u16(offset + 6, 0x0800);
    // Fixed 1980-01-01 timestamp makes archives reproducible for identical input.
    u16(offset + 12, 33);
    u32(offset + 14, entry.crc);
    u32(offset + 18, entry.bytes.length);
    u32(offset + 22, entry.bytes.length);
    u16(offset + 26, entry.nameBytes.length);
    output.set(entry.nameBytes, offset + 30);
    output.set(entry.bytes, offset + 30 + entry.nameBytes.length);
    offset += 30 + entry.nameBytes.length + entry.bytes.length;
  }
  const centralOffset = offset;
  for (const [index, entry] of prepared.entries()) {
    u32(offset, 0x02014b50);
    u16(offset + 4, 20);
    u16(offset + 6, 20);
    u16(offset + 8, 0x0800);
    u16(offset + 14, 33);
    u32(offset + 16, entry.crc);
    u32(offset + 20, entry.bytes.length);
    u32(offset + 24, entry.bytes.length);
    u16(offset + 28, entry.nameBytes.length);
    u32(offset + 42, positions[index]!);
    output.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.length;
  }
  u32(offset, 0x06054b50);
  u16(offset + 8, prepared.length);
  u16(offset + 10, prepared.length);
  u32(offset + 12, offset - centralOffset);
  u32(offset + 16, centralOffset);
  return output;
}
