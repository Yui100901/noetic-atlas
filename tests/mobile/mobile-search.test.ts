import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.ts';

test('native unified search updates safely, survives restart, upgrades old indexes and rebuilds restored caches', async t => {
  const folder = resolve('test-results/native-search'); await mkdir(folder, { recursive: true });
  await build({ configFile: false, logLevel: 'error', define: { 'process.env': '{}' }, resolve: { alias: nativeAliases }, build: { outDir: folder, emptyOutDir: false, minify: false, lib: { entry: resolve('mobile/runtime.ts'), formats: ['es'], fileName: () => 'runtime.mjs' } } });
  const { createLocalRuntime } = await import(pathToFileURL(resolve(folder, 'runtime.mjs')).href);
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const seed = { schemaVersion: 1, domains: [{ id: 'search-domain', name: '搜索领域', description: '', sortOrder: 0 }], categories: [{ id: 'search-category', domainId: 'search-domain', parentId: null, name: '搜索分类', description: '', sortOrder: 0 }], tags: [{ id: 'search-tag', name: '搜索标签', color: '#66CCFF', description: '', domainId: null, kind: 'topic' }], documents: [], papers: [], questions: [
    { id: 'SEARCH-Q', title: '搜索事务', type: 'short_answer', stemMarkdown: '本地数据一致性', answerMarkdown: 'REFERENCE_ONLY_CANARY', status: 'published', categoryIds: ['search-category'], tagIds: ['search-tag'] },
    { id: 'SEARCH-PENDING', title: '搜索待审核', type: 'short_answer', stemMarkdown: '未审核内容', status: 'pending', categoryIds: ['search-category'] },
    { id: 'SEARCH-GROUP', title: '程序阅读', type: 'group', stemMarkdown: '公共材料', status: 'published', categoryIds: ['search-category'], parts: [
      { id: 'first', title: '判断', type: 'true_false', stemMarkdown: '小题独有词', correctAnswers: ['true'] },
      { id: 'second', title: '解释', type: 'short_answer', stemMarkdown: '给出理由', answerMarkdown: '参考说明' },
    ] },
  ] };
  let durable: Uint8Array | undefined, saves = 0, failSave = false;
  const backups = new Map<string, Uint8Array>();
  const storage = {
    async load() { return durable?.slice(); },
    async save(bytes: Uint8Array) { if (failSave) throw new Error('simulated full storage'); durable = bytes.slice(); saves++; },
    async createRecoveryBackup(bytes: Uint8Array) { const id = `search-backup-${backups.size}`; backups.set(id, bytes.slice()); return { id, byteLength: bytes.length, createdAt: new Date().toISOString() }; },
    async loadRecoveryBackup(id: string) { return backups.get(id)!.slice(); },
  };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false }); t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', body?: unknown, expected = 200): Promise<any> => {
    const response = await runtime.fetch(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const search = (q: string, extra = '') => api('/api/search?q=' + encodeURIComponent(q) + extra);
  const paper = await api('/api/papers', 'POST', { title: '搜索题集', mode: 'manual', questionIds: ['SEARCH-Q', 'SEARCH-GROUP'] }, 201);
  await api('/api/documents', 'POST', { title: '搜索资料', kind: '学习笔记', bodyMarkdown: '# 正文\n原生专属命中词', categoryIds: ['search-category'] }, 201);
  await api('/api/study/SEARCH-Q', 'PUT', { notes: '搜索整题笔记 NATIVE_NOTE' });
  await api('/api/study/SEARCH-GROUP', 'PUT', { partId: 'second', notes: '搜索小题笔记 NATIVE_PART_NOTE' });
  let report = await search('搜索');
  assert.equal(report.counts.question, 1); assert.equal(report.counts.paper, 1); assert.equal(report.counts.document, 1); assert.equal(report.counts.note, 2);
  assert.equal(report.counts.domain, 1); assert.equal(report.counts.category, 1); assert.equal(report.counts.tag, 1); assert.equal(report.totalAll, 8);
  assert.equal((await search('搜索', '&includeUnpublished=true')).counts.question, 2);
  assert.equal((await search('原生专属命中词')).items[0].type, 'document');
  assert.equal((await search('小题独有词')).items[0].id, 'SEARCH-GROUP');
  const partNote = (await search('NATIVE_PART_NOTE')).items[0]; assert.equal(partNote.type, 'note'); assert.match(partNote.href, /[?&]part=second/);
  const reference = await search('REFERENCE_ONLY_CANARY'); assert.equal(reference.items[0].id, 'SEARCH-Q'); assert.equal(reference.items[0].matchIn, 'reference'); assert.ok(!JSON.stringify(reference.items).includes('REFERENCE_ONLY_CANARY'));
  const beforeReads = saves; await search('搜索'); await search(''); assert.equal(saves, beforeReads, 'search polling never exports a potentially large native database');
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  report = await search('搜索'); assert.equal(report.totalAll, 8);
  failSave = true;
  await api('/api/documents', 'POST', { title: 'UNSAVED_SEARCH_GHOST', kind: '笔记', bodyMarkdown: 'failed save' }, 507);
  failSave = false; assert.equal((await search('UNSAVED_SEARCH_GHOST')).totalAll, 0, 'failed writes cannot leak into search');
  // Simulate an earlier portable database. Startup must persist the new derived
  // structures once; normal search reads still never force a file export.
  await runtime.close();
  let copy = new sql.Database(durable!);
  copy.run('DROP TABLE search_read_model'); copy.run('DROP TABLE search_projection_pending'); copy.run("DELETE FROM metadata WHERE key='search_projection_version'");
  durable = copy.export(); copy.close(); const beforeUpgrade = saves;
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  assert.ok(saves > beforeUpgrade, 'new search schema is durably saved on native upgrade'); assert.equal((await search('搜索')).totalAll, 8);
  const backupResponse = await runtime.fetch('/api/backup.sqlite'); assert.equal(backupResponse.status, 200); const bytes = new Uint8Array(await backupResponse.arrayBuffer());
  copy = new sql.Database(bytes);
  copy.run("UPDATE search_read_model SET title_key='cached-search-poison',search_text='cached-search-poison',content='cached-search-poison'");
  const tampered = copy.export(); copy.close();
  const preview = await runtime.previewRestore(tampered, 'search-backup.sqlite'); await runtime.restore(preview.token);
  assert.equal((await search('cached-search-poison')).totalAll, 0, 'restores discard cached indexes and rederive authoritative content'); assert.equal((await search('搜索')).totalAll, 8);
  copy = new sql.Database(bytes); copy.run("UPDATE metadata SET value='999' WHERE key='search_projection_version'"); const future = copy.export(); copy.close();
  await assert.rejects(runtime.previewRestore(future, 'future-search.sqlite'), /搜索索引版本/);
  const spec = await api('/api/openapi.json'); assert.ok(spec.paths['/api/search']);
  assert.equal((await search('搜索')).items.some((item: any) => item.id === paper.id), true);
});
