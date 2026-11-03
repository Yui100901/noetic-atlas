import assert from 'node:assert/strict';
import { crc32 } from '../../shared/exports/zip.js';

/** Inspect STORE archives without a shell or an external zip dependency. */
export function readStoredZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    files = new Map<string, Uint8Array>();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 6, true), 0x0800, 'filenames are marked UTF-8');
    assert.equal(view.getUint16(offset + 8, true), 0, 'STORE does not require decompression');
    const size = view.getUint32(offset + 18, true),
      nameLength = view.getUint16(offset + 26, true),
      extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength,
      payload = bytes.slice(start, start + size);
    assert.equal(crc32(payload), view.getUint32(offset + 14, true), 'payload CRC matches');
    assert.ok(!files.has(name));
    files.set(name, payload);
    offset = start + size;
  }
  const centralOffset = offset;
  for (const name of files.keys()) {
    assert.equal(view.getUint32(offset, true), 0x02014b50);
    const nameLength = view.getUint16(offset + 28, true);
    assert.equal(
      new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      name,
    );
    const local = view.getUint32(offset + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    offset +=
      46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  assert.equal(view.getUint32(offset, true), 0x06054b50);
  assert.equal(view.getUint16(offset + 10, true), files.size);
  assert.equal(view.getUint32(offset + 12, true), offset - centralOffset);
  assert.equal(view.getUint32(offset + 16, true), centralOffset);
  assert.equal(offset + 22, bytes.byteLength);
  return files;
}
