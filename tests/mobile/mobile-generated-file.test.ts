import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeneratedFileSaver } from '../../mobile/generated-file.ts';
import { base64ToBytes } from '../../mobile/storage.ts';
import { generatedFileName } from '../../shared/assets/generated-file.ts';

test('Android generated files keep binary bytes, explicit MIME and unique export-only paths', async () => {
  const writes: any[] = [], shares: any[] = [];
  const save = createGeneratedFileSaver({ async writeFile(options: any) { writes.push(options); return { uri: `file:///cache/${options.path}` }; } }, { async share(options) { shares.push(options); } });
  const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 0, 255]);
  await save('../../危险/练习卷', pdf, 'application/pdf');
  await save('待审核.json', new Blob(['{"题目":"中文"}']), 'application/json; charset=utf-8');
  await save('练习.md', new Blob(['# 中文题目\n答案']), 'text/markdown; charset=utf-8');
  assert.equal(writes.length, 3);
  for (const entry of writes) {
    assert.match(entry.path, /^exports\/[\da-f-]{36}\/[\w\u0080-\uffff._-]+$/u);
    assert.equal(entry.recursive, true); assert.equal(entry.directory, 'CACHE');
    assert.ok(!entry.path.includes('/../'));
  }
  assert.deepEqual(base64ToBytes(writes[0].data), pdf);
  assert.equal(new TextDecoder().decode(base64ToBytes(writes[1].data)), '{"题目":"中文"}');
  assert.equal(new TextDecoder().decode(base64ToBytes(writes[2].data)), '# 中文题目\n答案');
  assert.deepEqual(shares.map(entry => entry.mimeType), ['application/pdf', 'application/json', 'text/markdown']);
  assert.ok(shares[0].uri.endsWith('.pdf')); assert.ok(shares[1].uri.endsWith('.json')); assert.ok(shares[2].uri.endsWith('.md'));
  await save('重复名称.pdf', pdf, 'application/pdf'); await save('重复名称.pdf', pdf, 'application/pdf');
  assert.notEqual(writes[3].path, writes[4].path, 'already shared files cannot be overwritten');
});

test('generated filename extensions survive long/unsafe titles and file failures surface', async () => {
  const safe = generatedFileName('..\\' + '很长'.repeat(100) + ' / ?\u0000', 'application/pdf');
  assert.ok(safe.filename.endsWith('.pdf')); assert.ok(safe.filename.length <= 124);
  assert.ok(!/[\\/\u0000]/.test(safe.filename));
  assert.equal(generatedFileName(' .. ', 'application/json').filename, '认知星图-导出.json');
  let shares = 0;
  const save = createGeneratedFileSaver({ async writeFile() { throw new Error('disk full'); } }, { async share() { shares++; } });
  await assert.rejects(save('卷.pdf', new Uint8Array([1]), 'application/pdf'), /disk full/); assert.equal(shares, 0);
});
