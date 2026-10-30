import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native source references and old bodies survive SQLite recovery and JSON migration', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime(),
    sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let saved: Uint8Array | undefined;
  const recovery = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return saved?.slice();
    },
    async save(bytes: Uint8Array) {
      saved = bytes.slice();
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = 'sources-' + recovery.size;
      recovery.set(id, bytes.slice());
      return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
    },
    async loadRecoveryBackup(id: string) {
      return recovery.get(id)!.slice();
    },
  };
  const empty = {
    schemaVersion: 1 as const,
    domains: [],
    categories: [],
    tags: [],
    questions: [],
    documents: [],
    papers: [],
  };
  let runtime = await createLocalRuntime(sql, empty, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await runtime.fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  await api(
    '/api/documents',
    'POST',
    { id: 'book', title: '手机教材', bodyMarkdown: '变量把名称与值关联。' },
    201,
  );
  const book = await api('/api/documents/book');
  await api(
    '/api/questions',
    'POST',
    {
      id: 'Q',
      title: '变量概念',
      type: 'short_answer',
      stemMarkdown: '什么是变量？',
      answerMarkdown: '名称和值的关联。',
      documentLinks: [
        {
          documentId: 'book',
          versionId: book.contentVersion,
          title: '手机教材',
          relation: 'summarized',
          label: '第一节',
          excerpt: '变量把名称与值关联。',
          startOffset: 0,
          endOffset: book.bodyMarkdown.length,
        },
      ],
    },
    201,
  );
  await api('/api/documents/book', 'PUT', { ...book, bodyMarkdown: '更新后的教材内容。' });
  const oldPath = `/api/documents/book/versions/${book.contentVersion}`;
  assert.equal((await api(oldPath)).bodyMarkdown, book.bodyMarkdown);
  assert.equal((await api('/api/documents/book/questions')).total, 1);
  const exported = await api('/api/export');
  assert.equal(exported.documentVersions.length, 1);
  const backup = await runtime.fetch('/api/backup.sqlite');
  const bytes = new Uint8Array(await backup.arrayBuffer());
  const preview = await runtime.previewRestore(bytes, 'source-links.sqlite');
  assert.equal(preview.counts.document_versions, 1);
  await runtime.restore(preview.token);
  assert.equal((await api(oldPath)).bodyMarkdown, book.bodyMarkdown);
  await runtime.close();
  saved = undefined;
  runtime = await createLocalRuntime(sql, empty, storage, { dailyPushScheduler: false });
  await api('/api/import', 'POST', { mode: 'merge', data: exported });
  assert.equal((await api(oldPath)).bodyMarkdown, book.bodyMarkdown);
  assert.equal((await api('/api/documents/book/questions')).total, 1);
});
