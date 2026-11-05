import { Gunzip } from 'fflate';
import { crc32 } from '../../../shared/exports/zip';

const MAX_FONT_BYTES = 32 * 1024 * 1024;
/** Local fonts remain complete; only their transport/storage representation is
 * compressed. Bound allocation and verify the gzip checksum before fontkit. */
export async function decodePdfFont(
  bytes: Uint8Array,
  nativeDecompression: typeof DecompressionStream | null = globalThis.DecompressionStream,
): Promise<Uint8Array> {
  if (
    bytes.length < 18 ||
    bytes.length > MAX_FONT_BYTES ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 8
  )
    throw new Error('本地 PDF 字体格式无效');
  const footer = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8);
  const expected = footer.getUint32(4, true);
  if (expected < 12 || expected > MAX_FONT_BYTES) throw new Error('本地 PDF 字体大小无效');
  const decoded = new Uint8Array(expected);
  let used = 0;
  const append = (chunk: Uint8Array) => {
    if (used + chunk.length > expected) throw new Error('本地 PDF 字体解压大小超过声明');
    decoded.set(chunk, used);
    used += chunk.length;
  };
  try {
    if (nativeDecompression) {
      // Native streaming yields to the UI thread and validates the gzip CRC.
      const reader = new Blob([bytes as BlobPart])
        .stream()
        .pipeThrough(new nativeDecompression('gzip'))
        .getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          append(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    } else {
      // Older WebViews remain fully offline; bound each inflater input chunk.
      const inflater = new Gunzip(append);
      for (let offset = 0; offset < bytes.length; offset += 4096)
        inflater.push(bytes.subarray(offset, offset + 4096), offset + 4096 >= bytes.length);
      if (crc32(decoded) !== footer.getUint32(0, true)) throw new Error('本地 PDF 字体已损坏');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('本地 PDF 字体')) throw error;
    throw new Error('本地 PDF 字体已损坏');
  }
  if (
    used !== expected ||
    new DataView(decoded.buffer, decoded.byteOffset, 4).getUint32(0) !== 0x00010000
  )
    throw new Error('本地 PDF 字体已损坏');
  return decoded;
}
