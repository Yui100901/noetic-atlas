/** Explicit live recommendation acceptance. Reads public vocabulary/configuration
 * only; recommendations, settings, usage and paper writes stay in memory. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { DatabaseConnection } from '../../server/database/connection.js';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import type { PrivateAiSettings } from '../../server/modules/ai/provider.js';
import { fixtureQuestion } from '../../tests/fixtures/learning-seed.js';

const folder = resolve(
  'test-results/ai-paper-plan-live',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(folder, { recursive: true });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function readSource() {
  const db = new DatabaseConnection(resolve('data/noetic-atlas.sqlite'), false);
  try {
    const settings = db.getRecord<PrivateAiSettings>('ai_settings', 'local');
    const x = db.expressions;
    const ids = db
      .all(
        db.query
          .selectFrom('questions')
          .select('id')
          .where('id', 'like', 'JA-V-%')
          .where(x.field('data', 'status'), '=', 'published')
          .where(x.field('data', 'collection'), '=', 'general')
          .orderBy('id'),
      )
      .map((row) => row.id);
    assert.ok(ids.length >= 450, 'LIVE_TEST_REQUIRES_PUBLIC_JAPANESE_VOCABULARY');
    const selected = Array.from(
      { length: 450 },
      (_, index) => ids[Math.floor((index * ids.length) / 450)]!,
    );
    const questions = db
      .all(db.query.selectFrom('questions').select('data').where(x.idInJson('id', selected)))
      .map((row) => JSON.parse(row.data));
    return { settings, questions };
  } finally {
    db.close();
  }
}
const source = readSource(),
  configHash = digest(source.settings);
assert.ok(
  source.settings?.enabled && source.settings.key && source.settings.model,
  'EXISTING_AI_CONFIGURATION_REQUIRED',
);
const config = source.settings,
  secret = config.key;
const endpoint = new URL(config.baseUrl);
assert.equal(endpoint.protocol, 'https:');
const store = new Store(':memory:'),
  app = Fastify({ logger: false });
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ApiError)
    return reply.code(error.status).send({ error: { code: error.code } });
  return reply.code(500).send({ error: { code: 'LIVE_TEST_INTERNAL_ERROR' } });
});
registerAiRoutes(app, store);
const originalFetch = globalThis.fetch;
const calls: Array<{ batch?: number; total?: number; candidates?: number; bytes: number }> = [];
const report: Record<string, unknown> = {
  ok: false,
  isolated: true,
  sourceDataModified: false,
  requestedQuestions: 200,
  candidates: 450,
  model: config.model,
  provider: endpoint.origin,
};
try {
  store.transaction(() => {
    store.put('domains', 'qa-ja', { id: 'qa-ja', name: '日语', description: '', sortOrder: 0 });
    store.put('categories', 'qa-ja-words', {
      id: 'qa-ja-words',
      domainId: 'qa-ja',
      parentId: null,
      name: '常用日语词汇（N5至N1）',
      description: '',
      sortOrder: 0,
    });
    for (const q of source.questions)
      store.put(
        'questions',
        q.id,
        fixtureQuestion(q.id, 'short_answer', {
          title: q.title,
          stemMarkdown: q.stemMarkdown.slice(0, 300),
          categoryIds: ['qa-ja-words'],
          tagIds: [],
          answerMarkdown: '本测试仅推荐已有词汇，不核验释义。',
          explanationMarkdown: '',
        }),
      );
    store.database.putRecord('ai_settings', 'local', {
      ...config,
      maxTokens: Math.max(config.maxTokens, 8192),
      timeoutSeconds: Math.max(config.timeoutSeconds, 120),
    });
  });
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    assert.ok(calls.length < 6, 'LIVE_RECOMMENDATION_REQUEST_LIMIT');
    const target = new URL(String(args[0]));
    assert.equal(target.origin, endpoint.origin, 'UNEXPECTED_PROVIDER');
    const body = typeof args[1]?.body === 'string' ? args[1].body : '';
    const material = JSON.parse(JSON.parse(body).messages[1].content).untrustedMaterial;
    calls.push({
      batch: material.selectionCount,
      total: material.paperQuestionCount,
      candidates: material.candidates?.length,
      bytes: Buffer.byteLength(body),
    });
    return originalFetch(...args);
  };
  const start = performance.now();
  const response = await app.inject({
    url: '/api/ai/paper-plan',
    method: 'POST',
    payload: {
      prompt:
        '请选择200道常用日语词汇，从基础逐步到进阶，覆盖N5至N1。不创建新词条。题集标题和描述应说明整份200道题，不要描述单批题数。',
    },
  });
  report.durationMs = Math.round(performance.now() - start);
  assert.equal(response.statusCode, 200, response.json().error?.code || 'AI_RECOMMENDATION_FAILED');
  const run = response.json(),
    result = run.result;
  assert.equal(result.requestedCount, 200);
  assert.equal(result.items.length, 200);
  assert.equal(new Set(result.items.map((item: any) => item.questionId)).size, 200);
  assert.equal(result.retrieval.batches, 4);
  assert.doesNotMatch(result.title + '\n' + result.description, /50\s*(?:题|道)|本批/);
  const selections = calls.filter((call) => call.batch !== undefined);
  assert.equal(selections.length, 4);
  assert.ok(selections.every((call) => call.batch === 50 && call.total === 200));
  const saved = await app.inject({
    url: `/api/ai/runs/${run.id}/paper`,
    method: 'POST',
    payload: {
      confirmed: true,
      title: result.title,
      description: result.description,
      questionIds: result.items.map((item: any) => item.questionId),
    },
  });
  assert.equal(saved.statusCode, 201, saved.json().error?.code || 'CREATE_RECOMMENDATION_FAILED');
  assert.equal(saved.json().paper.questionCount, 200);
  assert.doesNotMatch(
    saved.json().paper.title + '\n' + saved.json().paper.description,
    /50\s*(?:题|道)|本批/,
  );
  report.title = result.title;
  report.description = result.description;
  report.actualQuestions = result.items.length;
  report.batches = result.retrieval.batches;
  report.usage = run.diagnostics?.usage;
  report.warnings = run.warnings;
  report.checks = [
    'free-text count interpreted',
    'four selection batches',
    'whole-set count in every selection request',
    '200 unique existing questions',
    'preview metadata describes whole set',
    'saved paper count and metadata match',
    'no operator writes',
  ];
  report.ok = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : 'UNKNOWN_LIVE_TEST_FAILURE';
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  report.calls = calls;
  report.workingConfigurationUnchanged = digest(readSource().settings) === configHash;
  if (!report.workingConfigurationUnchanged) {
    report.ok = false;
    process.exitCode = 1;
  }
  await app.close();
  store.database.close();
  const safe = JSON.stringify(report, null, 2).replaceAll(secret, '[redacted]');
  await writeFile(resolve(folder, 'report.json'), safe + '\n');
  console.log(safe);
}
