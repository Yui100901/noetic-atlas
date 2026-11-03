import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContentExportFile, ContentExportScope } from '../../shared/models/domain-exports.js';
import {
  contentExportDefaults,
  contentExportKey,
  exportFileBytes,
  portableExportFilename,
} from '../../web/features/settings/domain-export-state.js';

test('export purpose defaults protect sharing while retaining migration status and personal content', () => {
  assert.deepEqual(contentExportDefaults('migration'), {
    purpose: 'migration',
    status: 'all',
    collection: 'all',
  });
  assert.deepEqual(contentExportDefaults('share'), {
    purpose: 'share',
    status: 'published',
    collection: 'general',
  });
});

test('export identity treats ordering as equal but invalidates changed scope and packaging', () => {
  const scope: ContentExportScope = {
    ...contentExportDefaults('migration'),
    domainIds: ['b', 'a'],
    mode: 'combined',
  };
  assert.equal(contentExportKey(scope), contentExportKey({ ...scope, domainIds: ['a', 'b', 'a'] }));
  for (const patch of [
    { status: 'published' },
    { collection: 'general' },
    { mode: 'per_domain' },
    { purpose: 'share' },
    { domainIds: ['a'] },
  ] as Partial<ContentExportScope>[])
    assert.notEqual(contentExportKey(scope), contentExportKey({ ...scope, ...patch }));
});

test('download decoding preserves UTF8 and validates size before allocation', () => {
  const text = JSON.stringify({ title: '语言学·题库' });
  const encoded = Buffer.from(text);
  const file: ContentExportFile = {
    filename: 'test.json',
    mimeType: 'application/json',
    dataBase64: encoded.toString('base64'),
    byteLength: encoded.length,
    summary: {
      questionCount: 1,
      domainCount: 1,
      fileCount: 1,
      purpose: 'migration',
      mode: 'combined',
    },
  };
  assert.equal(new TextDecoder().decode(exportFileBytes(file, 1024)), text);
  assert.throws(() => exportFileBytes(file, 1), /大小/);
  assert.throws(
    () => exportFileBytes({ ...file, byteLength: encoded.length + 1 }, 1024),
    /不完整|不一致/,
  );
  assert.throws(
    () => exportFileBytes({ ...file, dataBase64: '?'.repeat(file.dataBase64.length) }, 1024),
    /不完整/,
  );
  const large = new Uint8Array(60_001).map((_, index) => index % 251);
  assert.deepEqual(
    exportFileBytes(
      { ...file, byteLength: large.length, dataBase64: Buffer.from(large).toString('base64') },
      100_000,
    ),
    large,
  );
});

test('portable filename preserves readable Chinese and has no filesystem separators', () => {
  assert.equal(
    portableExportFilename('医学/药学:题库.json', 'application/json'),
    '医学_药学_题库.json',
  );
  assert.equal(portableExportFilename('', 'application/zip'), '认知星图-题库导出.zip');
});
