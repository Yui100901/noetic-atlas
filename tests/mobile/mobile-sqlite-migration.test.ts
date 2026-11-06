import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { fixtureQuestion, learningSeed } from '../fixtures/learning-seed.js';

test('Android exports whole/domain SQLite migrations and restores full answers, drafts, notes and FSRS chains atomically', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const seed = learningSeed();
  seed.domains.push({ id: 'other', name: '其他领域', description: '', sortOrder: 1 });
  seed.categories.push({
    id: 'other-category',
    domainId: 'other',
    parentId: null,
    name: '其他基础',
    description: '',
    sortOrder: 0,
  });
  seed.questions.push(
    ...['OTHER-DEPENDENCY', 'OTHER-PRIVATE'].map((id) =>
      fixtureQuestion(id, 'true_false', {
        categoryIds: ['other-category'],
        tagIds: [],
        stemMarkdown: id === 'OTHER-PRIVATE' ? 'PRIVATE-NATIVE-MIGRATION-CONTENT' : '跨域依赖',
      }),
    ),
  );
  let durable: Uint8Array | undefined,
    saves = 0;
  const backups = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      durable = bytes.slice();
      saves++;
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = `migration-${backups.size}`;
      backups.set(id, bytes.slice());
      return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
    },
    async loadRecoveryBackup(id: string) {
      return backups.get(id)!.slice();
    },
  };
  const runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', body?: unknown, expected = 200): Promise<any> => {
    const response = await runtime.fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  const mixed = await api(
    '/api/papers',
    'POST',
    { title: '跨域迁移', mode: 'manual', questionIds: ['FIXTURE-BOOL', 'OTHER-DEPENDENCY'] },
    201,
  );
  const other = await api(
    '/api/papers',
    'POST',
    { title: '不相关题集', mode: 'manual', questionIds: ['OTHER-DEPENDENCY', 'OTHER-PRIVATE'] },
    201,
  );
  const attempt = await api(`/api/papers/${mixed.id}/attempts`, 'POST', {}, 201);
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', {
    answers: { 'FIXTURE-BOOL': { value: 'false' }, 'OTHER-DEPENDENCY': { value: 'true' } },
  });
  const draft = await api(`/api/papers/${mixed.id}/attempts`, 'POST', {}, 201);
  await api('/api/study/FIXTURE-BOOL', 'PUT', { favorite: true, notes: '移动端保留笔记' });
  await api('/api/ai/settings', 'PUT', {
    enabled: true,
    baseUrl: 'https://example.com/v1',
    model: 'fake',
    key: 'NATIVE-MIGRATION-SECRET',
    supportsImages: false,
    sendImages: false,
    timeoutSeconds: 60,
    maxTokens: 8192,
  });
  const card = await api('/api/review-scheduler/card?questionId=FIXTURE-BOOL');
  assert.equal(card.eventCount, 1);
  const fetchMigration = async (domainIds: string[]) => {
    const before = saves,
      disk = durable!.slice();
    const preview = await api('/api/migrations/preview', 'POST', { domainIds });
    const response = await runtime.fetch(
      `/api/migrations/database?domainIds=${encodeURIComponent(JSON.stringify(domainIds))}&fingerprint=${preview.fingerprint}`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(saves, before, 'preview/export must not commit source learning data');
    assert.deepEqual(durable, disk);
    return { bytes: new Uint8Array(await response.arrayBuffer()), preview };
  };
  const whole = await fetchMigration([]),
    wholePreview = await runtime.previewRestore(whole.bytes, 'whole.sqlite');
  assert.equal(wholePreview.counts.questions, 8);
  assert.equal(wholePreview.counts.papers, 2);
  const domain = await fetchMigration(['fixture-computer']);
  assert.equal(domain.preview.dependencyQuestions, 1);
  assert.equal(
    Buffer.from(domain.bytes).includes(Buffer.from('PRIVATE-NATIVE-MIGRATION-CONTENT')),
    false,
  );
  assert.equal(Buffer.from(domain.bytes).includes(Buffer.from('NATIVE-MIGRATION-SECRET')), false);
  const preview = await runtime.previewRestore(domain.bytes, 'domain.sqlite');
  assert.equal(preview.counts.questions, 7);
  assert.equal(preview.counts.attempts, 2);
  assert.equal(preview.counts.review_events, 2);
  await runtime.restore(preview.token);
  const history = await api(`/api/attempts/${attempt.id}`),
    restoredDraft = await api(`/api/attempts/${draft.id}`);
  assert.equal(history.questions.length, 2);
  assert.equal(history.answers['FIXTURE-BOOL'].value, 'false');
  assert.equal(restoredDraft.status, 'in_progress');
  assert.equal((await api('/api/questions/FIXTURE-BOOL')).study.notes, '移动端保留笔记');
  assert.equal(
    (await api('/api/review-scheduler/card?questionId=FIXTURE-BOOL')).eventCount,
    card.eventCount,
  );
  await api(`/api/papers/${other.id}`, 'GET', undefined, 404);
  await api('/api/questions/OTHER-PRIVATE', 'GET', undefined, 404);
  assert.equal(backups.size, 1, 'restore retains independent recovery copy');
});
