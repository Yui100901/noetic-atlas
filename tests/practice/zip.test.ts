import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createStoredZip, createCompressedZip } from '../../shared/exports/zip.js';
import { unzipSync } from 'fflate';
import { readStoredZip } from '../helpers/stored-zip.js';

test('portable STORE ZIP roundtrips UTF-8 names, CRCs, zero bytes and deterministic records', () => {
  const payload = new TextEncoder().encode('123456789');
  assert.equal(crc32(payload), 0xcbf43926);
  assert.equal(crc32(new Uint8Array()), 0);
  const entries = [
    { name: '领域/题库.json', bytes: payload },
    { name: 'empty.json', bytes: new Uint8Array() },
  ];
  const bytes = createStoredZip(entries, 1024),
    files = readStoredZip(bytes);
  assert.deepEqual(files.get('领域/题库.json'), payload);
  assert.equal(files.get('empty.json')!.length, 0);
  assert.deepEqual(createStoredZip(entries, 1024), bytes);
  const corrupt = bytes.slice();
  corrupt[30 + new TextEncoder().encode(entries[0]!.name).length] ^= 1;
  assert.throws(() => readStoredZip(corrupt), /payload CRC/);
});
test('portable ZIP rejects unsafe paths, duplicate files and allocation over budget', () => {
  for (const name of [
    '../escape',
    '/absolute',
    'a/../escape',
    'C:escape',
    'a\\escape',
    '',
    'a/./file',
    'control\u0000',
  ])
    assert.throws(() => createStoredZip([{ name, bytes: new Uint8Array() }], 1024), /文件名/);
  assert.throws(
    () =>
      createStoredZip(
        [
          { name: 'same', bytes: new Uint8Array() },
          { name: 'same', bytes: new Uint8Array() },
        ],
        1024,
      ),
    /重复/,
  );
  assert.throws(
    () => createStoredZip([{ name: 'safe', bytes: new Uint8Array(200) }], 100),
    /大小上限/,
  );
  assert.equal(readStoredZip(createStoredZip([], 22)).size, 0);
});

test('compressed ZIP shrinks text without recompressing media and retains expanded allocation limits', () => {
  const text = new TextEncoder().encode('中文术语与参考答案。'.repeat(2000));
  const entries = [
    { name: 'data/题目.json', bytes: text },
    { name: 'assets/picture.png', bytes: text },
  ];
  const stored = createStoredZip(entries, 200000),
    compressed = createCompressedZip(entries, 200000, 200000);
  assert.ok(compressed.length < stored.length * 0.6);
  const files = unzipSync(compressed);
  assert.deepEqual(files['data/题目.json'], text);
  assert.deepEqual(files['assets/picture.png'], text);
  assert.deepEqual(createCompressedZip(entries, 200000, 200000), compressed);
  const view = new DataView(compressed.buffer);
  assert.equal(view.getUint16(8, true), 8, 'text uses DEFLATE');
  const second = 30 + new TextEncoder().encode(entries[0]!.name).length + view.getUint32(18, true);
  assert.equal(view.getUint16(second + 8, true), 0, 'media stays STORE');
  assert.throws(() => createCompressedZip(entries, 200000, text.length), /解压内容超过/);
  assert.throws(() => createCompressedZip(entries, 50, 200000), /大小上限/);
});

test('compressed ZIP can fit a transfer budget while enforcing the independent expanded budget', () => {
  const bytes = new TextEncoder().encode('repeatable content\n'.repeat(10000));
  const entry = [{ name: 'content.json', bytes }];
  assert.throws(() => createStoredZip(entry, 4096), /大小上限/);
  assert.deepEqual(
    unzipSync(createCompressedZip(entry, 4096, bytes.length))['content.json'],
    bytes,
  );
  assert.throws(() => createCompressedZip(entry, 4096, bytes.length - 1), /解压内容超过/);
});
