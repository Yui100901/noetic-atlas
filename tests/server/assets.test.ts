import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { bytesToBase64, assetUrl, assetIdFromUrl } from '../../shared/assets/assets.js';
import { decodeAssetBase64, sanitizeAssetFilename, validateAssetBytes, validateAssetRecord } from '../../server/modules/assets/schema.js';
import { collectAssetReferences, validateAssetReferences } from '../../server/modules/assets/routes.js';
import { Store } from '../../server/core/store.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
function minimalPdf(): Uint8Array {
  let text = '%PDF-1.4\n'; const offsets = [0];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  objects.forEach((body, index) => { offsets.push(text.length); text += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = text.length; text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
const json = (reply: { statusCode: number; json: () => any }, expected = 200) => { assert.equal(reply.statusCode, expected, JSON.stringify(reply.json())); return reply.json(); };
async function fixture(t: test.TestContext) {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'test-results/no-asset-seed.json', staticRoot: 'test-results/no-asset-web' }); t.after(() => app.close()); return app;
}
test('asset bytes validate canonical Base64, UTF-8, image signatures/dimensions and reject fake PDF/SVG', () => {
  for (const value of ['eA', ' eA==', 'eA==\n', 'eB==', 'data:text/plain;base64,eA==', '====']) assert.throws(() => decodeAssetBase64(value));
  assert.equal(new TextDecoder().decode(decodeAssetBase64('eA==')), 'x');
  assert.deepEqual(validateAssetBytes(decodeAssetBase64(png), 'image/png'), { width: 1, height: 1 });
  assert.throws(() => validateAssetBytes(new TextEncoder().encode('<svg></svg>'), 'image/png'));
  assert.throws(() => validateAssetBytes(new TextEncoder().encode('%PDF-1.7\njust text\n%%EOF'), 'application/pdf'));
  assert.throws(() => validateAssetBytes(Uint8Array.from([0xff, 0xff]), 'text/markdown'));
  assert.throws(() => validateAssetBytes(new TextEncoder().encode('valid\0invalid'), 'text/markdown'));
  assert.throws(() => validateAssetBytes(decodeAssetBase64(png), 'image/png', { maxDocumentMiB: 20, maxImageMiB: 0.000001 }));
  assert.equal(sanitizeAssetFilename('../资料/图像:1.png'), '图像_1.png');
});
test('asset metadata is canonical and migration size/dimensions cannot lie', () => {
  const record = { id: 'asset-test', filename: 'image.png', mimeType: 'image/png', dataBase64: png, sizeBytes: decodeAssetBase64(png).length, width: 1, height: 1, createdAt: '2026-10-21T00:00:00.000Z' };
  assert.deepEqual(validateAssetRecord(record), record);
  assert.throws(() => validateAssetRecord({ ...record, sizeBytes: 1 })); assert.throws(() => validateAssetRecord({ ...record, width: 200 })); assert.throws(() => validateAssetRecord({ ...record, filename: '../image.png' }));
  assert.equal(assetIdFromUrl(assetUrl(record.id)), record.id); assert.equal(assetIdFromUrl('https://example.org' + assetUrl(record.id)), null);
});
test('asset API uploads metadata, returns exact bytes and deletes unreferenced resources', async t => {
  const app = await fixture(t);
  const metadata = json(await app.inject({ method: 'POST', url: '/api/assets', payload: { filename: '../test.png', mimeType: 'image/png', dataBase64: png } }), 201);
  assert.equal(metadata.filename, 'test.png'); assert.equal(metadata.dataBase64, undefined); assert.equal(metadata.width, 1);
  assert.equal(json(await app.inject(`/api/assets/${metadata.id}/data`)).dataBase64, png);
  const content = await app.inject(`/api/assets/${metadata.id}/content`); assert.equal(content.statusCode, 200); assert.equal(content.headers['content-type'], 'image/png'); assert.deepEqual(new Uint8Array(content.rawPayload), decodeAssetBase64(png));
  assert.equal(json(await app.inject('/api/assets'))[0].referenced, false);
  json(await app.inject({ method: 'DELETE', url: `/api/assets/${metadata.id}` })); json(await app.inject(`/api/assets/${metadata.id}`), 404);
  json(await app.inject({ method: 'POST', url: '/api/assets', payload: { filename: 'danger.svg', mimeType: 'image/svg+xml', dataBase64: bytesToBase64(new TextEncoder().encode('<svg/>')) } }), 400);
});
test('Markdown image references validate nested parts and protect historical snapshots after editing source', async t => {
  const app = await fixture(t);
  const asset = json(await app.inject({ method: 'POST', url: '/api/assets', payload: { filename: 'test.png', mimeType: 'image/png', dataBase64: png } }), 201);
  const question = json(await app.inject({ method: 'POST', url: '/api/questions', payload: { id: 'image-question', title: '看图答题', type: 'short_answer', stemMarkdown: `![测试图片](${assetUrl(asset.id)})` } }), 201);
  json(await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}` }), 409);
  json(await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ids: [question.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [question.id]: question.updatedAt } } }));
  const paper = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '图片快照', mode: 'manual', questionIds: [question.id] } }), 201);
  const latest = json(await app.inject('/api/questions/image-question'));
  json(await app.inject({ method: 'PUT', url: '/api/questions/image-question', payload: { ...latest, study: undefined, stemMarkdown: '已移除图片' } }));
  json(await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}` }), 409);
  assert.equal(paper.questions[0].stemMarkdown, `![测试图片](${assetUrl(asset.id)})`);
  json(await app.inject({ method: 'POST', url: '/api/questions', payload: { title: '缺图', type: 'short_answer', stemMarkdown: '![不存在](/api/assets/absent/content)' } }), 400);
});
test('asset collection covers documents, nested question parts, notes and historical answers', () => {
  const refs = collectAssetReferences({ assetId: 'pdf', parts: [{ stemMarkdown: '![img](/api/assets/image/content)' }], answers: { q: { value: '![笔记](/api/assets/notes/content)' } } });
  assert.deepEqual([...refs].sort(), ['image', 'notes', 'pdf']);
  const store = new Store(':memory:'); try {
    assert.throws(() => validateAssetReferences(store, { format: 'pdf', bodyMarkdown: '', assetId: null }));
    assert.throws(() => validateAssetReferences(store, { stemMarkdown: '![unsafe](data:image/svg+xml;base64,PHN2Zy8+)' }));
    validateAssetReferences(store, { stemMarkdown: `![内嵌图片](data:image/png;base64,${png})` });
  } finally { store.db.close(); }
});
test('PDF documents require PDF assets and full migration retains bytes with atomic rejection of damaged assets', async t => {
  const app = await fixture(t); const pdf = minimalPdf();
  const asset = json(await app.inject({ method: 'POST', url: '/api/assets', payload: { filename: '学习资料.pdf', mimeType: 'application/pdf', dataBase64: bytesToBase64(pdf) } }), 201);
  const input = { id: 'pdf-document', title: 'PDF学习资料', format: 'pdf', bodyMarkdown: '', assetId: asset.id, fileName: asset.filename };
  json(await app.inject({ method: 'POST', url: '/api/documents', payload: { ...input, assetId: null } }), 400);
  json(await app.inject({ method: 'POST', url: '/api/documents', payload: input }), 201);
  json(await app.inject({ method: 'DELETE', url: `/api/assets/${asset.id}` }), 409);
  const backup = json(await app.inject('/api/export')); assert.equal(backup.assets.length, 1); assert.equal(backup.assets[0].dataBase64, bytesToBase64(pdf));
  const restored = await fixture(t); json(await restored.inject({ method: 'POST', url: '/api/import', payload: { data: backup, mode: 'merge' } }));
  assert.equal(json(await restored.inject('/api/documents/pdf-document')).assetId, asset.id);
  assert.deepEqual(new Uint8Array((await restored.inject(`/api/assets/${asset.id}/content`)).rawPayload), pdf);
  const bad = structuredClone(backup); bad.assets[0].id = 'asset-bad'; bad.assets[0].sizeBytes = 1; bad.documents[0].id = 'pdf-bad'; bad.documents[0].assetId = 'asset-bad';
  json(await restored.inject({ method: 'POST', url: '/api/import', payload: { data: bad, mode: 'merge' } }), 400);
  json(await restored.inject('/api/assets/asset-bad'), 404); json(await restored.inject('/api/documents/pdf-bad'), 404);
  assert.equal(json(await restored.inject('/api/assets')).length, 1);
});
