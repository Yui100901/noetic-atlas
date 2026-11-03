import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, createStoredZip } from '../../shared/exports/zip.js';
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
