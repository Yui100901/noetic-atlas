import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { decodePdfFont } from '../../web/shared/export/pdf-font.js';

test('compressed offline PDF font decodes to the complete original Chinese font', async () => {
  const original = await readFile('web/assets/fonts/NotoSansSC-Regular.ttf');
  const packed = gzipSync(original, { level: 9 });
  assert.ok(packed.length < original.length * 0.7);
  assert.deepEqual(await decodePdfFont(packed), new Uint8Array(original));
  assert.deepEqual(await decodePdfFont(packed, null), new Uint8Array(original));
});

test('PDF font rejects corrupt, truncated, oversized and falsely declared expansions', async () => {
  await assert.rejects(() => decodePdfFont(new Uint8Array(17)), /格式无效/);
  const valid = new Uint8Array(gzipSync(new Uint8Array([0, 1, 0, 0, ...new Uint8Array(10000)])));
  const badCrc = valid.slice();
  badCrc[badCrc.length - 8] ^= 1;
  await assert.rejects(() => decodePdfFont(badCrc), /已损坏/);
  await assert.rejects(() => decodePdfFont(badCrc, null), /已损坏/);
  const oversized = valid.slice();
  new DataView(oversized.buffer).setUint32(oversized.length - 4, 0xffffffff, true);
  await assert.rejects(() => decodePdfFont(oversized), /大小无效/);
  const lied = valid.slice();
  new DataView(lied.buffer).setUint32(lied.length - 4, 12, true);
  await assert.rejects(() => decodePdfFont(lied), /超过声明|已损坏/);
  await assert.rejects(() => decodePdfFont(lied, null), /超过声明/);
  await assert.rejects(() => decodePdfFont(valid.subarray(0, valid.length - 5)));
});
