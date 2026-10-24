import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.ts';
import { learningSeed } from '../fixtures/learning-seed.js';

test('mobile offline assets, configuration and paper organization use the exact production runtime', async t => {
  const folder = resolve('test-results/native-settings-assets'); await mkdir(folder, { recursive: true });
  await build({ configFile: false, logLevel: 'error', define: { 'process.env': '{}' }, resolve: { alias: nativeAliases }, build: { outDir: folder, emptyOutDir: false, minify: false, lib: { entry: resolve('mobile/runtime.ts'), formats: ['es'], fileName: () => 'runtime.mjs' } } });
  const { createLocalRuntime } = await import(pathToFileURL(resolve(folder, 'runtime.mjs')).href);
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const seed = learningSeed();
  let durable: Uint8Array | undefined, failSave = false;
  const storage = { async load() { return durable?.slice(); }, async save(value: Uint8Array) { if (failSave) throw new Error('disk full'); durable = value.slice(); } };
  let runtime = await createLocalRuntime(sql, seed, storage); t.after(() => runtime.close());
  async function api(path: string, method = 'GET', body?: unknown, status = 200): Promise<any> { const response = await runtime.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; }
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bZkAAAAASUVORK5CYII=';
  let image: any, question: any, paper: any, submitted: any;
  await t.test('image binary upload/download is byte-identical, bounded and durable across reopen', async () => {
    image = await api('/api/assets', 'POST', { filename: '手机题图.png', mimeType: 'image/png', dataBase64: pngBase64 }, 201);
    assert.equal(image.width, 1); assert.equal(image.dataBase64, undefined);
    const binary = await runtime.fetch(`/api/assets/${image.id}/content`); assert.equal(binary.headers.get('Content-Type'), 'image/png'); assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), new Uint8Array(Buffer.from(pngBase64, 'base64')));
    await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
    assert.equal((await api(`/api/assets/${image.id}/data`)).dataBase64, pngBase64);
    const before = durable!.slice(); failSave = true;
    await api('/api/assets', 'POST', { filename: '不可落盘.png', mimeType: 'image/png', dataBase64: pngBase64 }, 507); failSave = false;
    assert.deepEqual(durable, before); assert.equal((await api('/api/assets')).length, 1);
  });
  await t.test('managed image references survive paper snapshots and cannot be deleted while referenced', async () => {
    question = await api('/api/questions', 'POST', { id: 'MOBILE-ASSET-QUESTION', title: '离线有图题', type: 'short_answer', stemMarkdown: `观察题图\n\n![手机题图](/api/assets/${image.id}/content)`, answerMarkdown: '说明图片含义', categoryIds: [seed.categories[0].id], tagIds: [] }, 201);
    await api('/api/questions/review', 'POST', { ids: [question.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [question.id]: question.updatedAt } });
    paper = await api('/api/papers', 'POST', { title: '手机图片领域专项', mode: 'manual', organization: 'domain', domainId: seed.domains[0].id, questionIds: [question.id], scoring: { enabled: false } }, 201);
    assert.equal(paper.organization, 'domain'); assert.equal(paper.domainId, seed.domains[0].id);
    const attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', undefined, 201);
    submitted = await api(`/api/attempts/${attempt.id}/submit`, 'POST', { answers: { [question.id]: { value: '离线作答' } } });
    await api(`/api/papers/${paper.id}?permanent=true`, 'DELETE'); await api(`/api/questions/${question.id}`, 'DELETE');
    assert.equal((await api(`/api/attempts/${attempt.id}`)).answers[question.id].value, '离线作答');
    assert.equal((await api(`/api/assets/${image.id}`, 'DELETE', undefined, 409)).error.code, 'ASSET_IN_USE');
    assert.ok((await api(`/api/attempts/${attempt.id}/export-document?mode=completed`)).markdown.includes(`/api/assets/${image.id}/content`));
  });
  await t.test('configuration persists and dynamic draft/history limits apply separately', async () => {
    const settings = await api('/api/settings'); assert.equal(settings.maxDraftsPerPaper, 3);
    const saved = await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark', maxDraftsPerPaper: 2, maxQuickDrafts: 1, maxHistoryPerPaper: 1, randomQuestionCount: 7, autosaveDebounceMs: 250 } });
    assert.equal(saved.settings.maxDraftsPerPaper, 2);
    const source = seed.questions.find((q: any) => q.status === 'published' && q.type === 'true_false');
    const draftPaper = await api('/api/papers', 'POST', { title: '配置保留验证', mode: 'manual', questionIds: [source.id], scoring: { enabled: false } }, 201);
    for (let i = 0; i < 3; i++) await api(`/api/papers/${draftPaper.id}/attempts`, 'POST', undefined, 201);
    assert.equal((await api(`/api/papers/${draftPaper.id}/drafts`)).length, 2);
    for (let i = 0; i < 2; i++) { const a = await api(`/api/papers/${draftPaper.id}/attempts`, 'POST', undefined, 201); await api(`/api/attempts/${a.id}/submit`, 'POST', { answers: {} }); }
    assert.equal((await api(`/api/attempts?paperId=${draftPaper.id}&status=submitted`)).length, 1);
    for (let i = 0; i < 2; i++) await api('/api/quick-practice', 'POST', { questionId: source.id }, 201);
    assert.equal((await api('/api/attempts?source=quick&status=in_progress')).length, 1);
    await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage); assert.equal((await api('/api/bootstrap')).settings.autosaveDebounceMs, 250); assert.equal((await api('/api/bootstrap')).settings.theme, 'dark');
  });
  await t.test('Markdown and PDF materials plus managed assets/settings migrate together', async () => {
    const { PDFDocument } = await import('pdf-lib'); const pdf = await PDFDocument.create(); pdf.addPage([120, 120]); const pdfBytes = await pdf.save();
    const pdfAsset = await api('/api/assets', 'POST', { filename: '离线资料.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from(pdfBytes).toString('base64') }, 201);
    const document = await api('/api/documents', 'POST', { title: '手机 PDF 资料', format: 'pdf', assetId: pdfAsset.id, fileName: '离线资料.pdf', bodyMarkdown: '', categoryIds: [], tagIds: [] }, 201);
    const backup = await api('/api/export'); assert.ok(backup.assets.some((entry: any) => entry.id === pdfAsset.id)); assert.ok(backup.settings.some((entry: any) => entry.id === 'system'));
    await runtime.close(); durable = undefined; runtime = await createLocalRuntime(sql, seed, storage);
    await api('/api/import', 'POST', { mode: 'merge', data: backup });
    assert.equal((await api(`/api/documents/${document.id}`)).assetId, pdfAsset.id); assert.equal((await api(`/api/attempts/${submitted.id}`)).status, 'submitted');
    assert.equal((await api(`/api/assets/${image.id}/data`)).dataBase64, pngBase64);
    const restored = await runtime.fetch(`/api/assets/${pdfAsset.id}/content`); assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), pdfBytes); assert.equal((await api('/api/settings')).maxDraftsPerPaper, 2);
  });
});
