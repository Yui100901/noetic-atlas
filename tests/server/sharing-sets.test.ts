import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/index.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { Store } from '../../server/core/store.js';
import { fixtureQuestion, learningSeed } from '../fixtures/learning-seed.js';
import { importData } from '../../server/modules/transfer/migration.js';
import { buildPaper, createAttempt, submitAttempt } from '../../server/modules/practice/service.js';
import { exportShare, planShareImport } from '../../server/modules/sharing/service.js';
import { previewPackageExport } from '../../server/modules/transfer/export-preflight.js';
import { readDataPackage } from '../../shared/packages/data-package.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  importData(store, learningSeed());
  const paper = (title: string, ids: string[], extra: Record<string, unknown> = {}) => {
    const value = buildPaper(store, {
      title,
      description: '',
      mode: 'manual',
      questionIds: ids,
      scoring: { enabled: false },
      ...extra,
    } as any);
    store.insert('papers', value.id, value);
    return value;
  };
  return { store, paper };
}
test('batch paper shares deduplicate ordinary roots, keep all frozen papers and import as a single graph', (t) => {
  const { store, paper } = fixture(t),
    one = paper('同领域第一卷', ['FIXTURE-BOOL', 'FIXTURE-CHOICE-1']),
    two = paper('同领域第二卷', ['FIXTURE-BOOL', 'FIXTURE-SHORT-1']);
  const packet = exportShare(store, { kind: 'paper', ids: [one.id, two.id] });
  assert.equal(packet.papers.length, 2);
  assert.equal(packet.questions.length, 3);
  assert.equal(packet.papers[0]!.snapshot[0]!.stemMarkdown, one.snapshot[0]!.stemMarkdown);
  const target = new Store(':memory:');
  t.after(() => target.database.close());
  const preview = planShareImport(target, packet, { enabled: false }).preview;
  assert.equal(preview.counts.papers!.added, 2);
  assert.equal(preview.counts.questions!.added, 3);
});
test('different frozen versions of one root and their rubric/score identities remain independently importable', (t) => {
  const { store, paper } = fixture(t),
    one = paper('旧内容卷', ['FIXTURE-SHORT-1'], {
      scoring: { enabled: true, questionPoints: { 'FIXTURE-SHORT-1': 7 } },
      questionGradingRequirements: { 'FIXTURE-SHORT-1': '按旧版要求核对' },
    });
  const q = store.require<any>('questions', 'FIXTURE-SHORT-1');
  store.put('questions', q.id, {
    ...q,
    stemMarkdown: '新版题干',
    answerMarkdown: '新版答案',
    gradingRequirements: '新版基线',
  });
  const two = paper('新版内容卷', [q.id], {
    scoring: { enabled: true, questionPoints: { [q.id]: 9 } },
    questionGradingRequirements: { [q.id]: '按新版要求核对' },
  });
  const packet = exportShare(store, { kind: 'paper', ids: [one.id, two.id] });
  assert.equal(packet.questions.length, 2);
  assert.notEqual(packet.papers[0]!.questionIds[0], packet.papers[1]!.questionIds[0]);
  for (const [index, points] of [7, 9].entries()) {
    const p = packet.papers[index]!;
    assert.equal(p.scoring!.questionPoints[p.questionIds[0]!], points);
    assert.match(p.questionGradingRequirements![p.questionIds[0]!]!, index === 0 ? /旧版/ : /新版/);
  }
  const target = new Store(':memory:');
  t.after(() => target.database.close());
  assert.equal(planShareImport(target, packet, { enabled: false }).preview.counts.papers!.added, 2);
});
test('batch linked snapshot conflicts propagate without losing references or duplicating unchanged roots', (t) => {
  const { store, paper } = fixture(t);
  const first = store.require<any>('questions', 'FIXTURE-SHORT-1'),
    second = store.require<any>('questions', 'FIXTURE-SHORT-2');
  store.put('questions', first.id, {
    ...first,
    stemMarkdown: '阅读 [另一题](#/questions/FIXTURE-SHORT-2) 并回答。',
  });
  const one = paper('旧关联卷', [first.id, second.id, 'FIXTURE-BOOL']);
  store.put('questions', second.id, { ...second, answerMarkdown: '这个答案已经修改' });
  const two = paper('新关联卷', [first.id, second.id, 'FIXTURE-BOOL']);
  const packet = exportShare(store, { kind: 'paper', ids: [one.id, two.id] });
  assert.equal(packet.questions.length, 5);
  for (const p of packet.papers) {
    assert.ok(p.snapshot[0]!.stemMarkdown.includes('#/questions/' + p.snapshot[1]!.id));
  }
  assert.equal(packet.papers[0]!.questionIds[2], packet.papers[1]!.questionIds[2]);
  const target = new Store(':memory:');
  t.after(() => target.database.close());
  assert.equal(planShareImport(target, packet, { enabled: false }).preview.counts.papers!.added, 2);
});
test('filtered paper shares select all matching pages and refuse over 100 before snapshot reads', (t) => {
  const { store, paper } = fixture(t);
  for (let i = 0; i < 26; i++) paper('批量卷 ' + i, ['FIXTURE-BOOL']);
  paper('其他标题', ['FIXTURE-MULTI']);
  const packet = exportShare(store, { kind: 'paper', filters: { search: '批量卷' } });
  assert.equal(packet.papers.length, 26);
  assert.equal(packet.questions.length, 1);
  for (let i = 26; i < 101; i++) paper('批量卷 ' + i, ['FIXTURE-BOOL']);
  const original = store.require.bind(store);
  store.require = ((table: any, id: string) => {
    if (table === 'papers') throw Error('must not load paper bodies before scope rejection');
    return original(table, id);
  }) as any;
  assert.throws(
    () =>
      previewPackageExport(store, {
        kind: 'share',
        selection: { kind: 'paper', filters: { search: '批量卷' } },
      }),
    (error: any) => error.code === 'SHARE_PAPER_LIMIT',
  );
});
test('special wrong/favorite/due shares exclude personal learning evidence and keep deleted wrong snapshots', (t) => {
  const { store, paper } = fixture(t),
    p = paper('PRIVATE_ORIGIN_TITLE', ['FIXTURE-BOOL']);
  const a = submitAttempt(store, createAttempt(store, p), { 'FIXTURE-BOOL': { value: 'false' } });
  store.put('study', 'FIXTURE-BOOL', {
    questionId: 'FIXTURE-BOOL',
    favorite: true,
    mastery: 0,
    notes: 'DO_NOT_SHARE_LEARNING_NOTE',
    nextReviewAt: '2020-01-01T00:00:00.000Z',
    lastReviewedAt: null,
    wrongCount: 1,
  });
  store.put('settings', 'system', {
    ...DEFAULT_SETTINGS,
    reviewScheduling: { ...DEFAULT_SETTINGS.reviewScheduling, strategy: 'fixed' },
  });
  for (const kind of ['wrong', 'favorite', 'due'] as const) {
    const packet = exportShare(store, { kind: 'learning', learning: { kind } });
    assert.equal(packet.questions.length, 1);
    const text = JSON.stringify(packet);
    assert.ok(!text.includes('DO_NOT_SHARE_LEARNING_NOTE'));
    assert.ok(!text.includes(a.id));
    assert.ok(!text.includes('PRIVATE_ORIGIN_TITLE'));
    assert.equal(packet.papers.length, 0);
  }
  store.remove('questions', 'FIXTURE-BOOL');
  const packet = exportShare(store, { kind: 'learning', learning: { kind: 'wrong' } });
  assert.equal(packet.questions[0]!.stemMarkdown, p.snapshot[0]!.stemMarkdown);
  assert.equal(
    previewPackageExport(store, {
      kind: 'share',
      selection: { kind: 'learning', learning: { kind: 'wrong' } },
    }).questionCount,
    1,
  );
});
test('grouped special-set shares retain common material and selected leaf answer without other parts', (t) => {
  const { store, paper } = fixture(t);
  const q = fixtureQuestion('GROUP', 'group', {
    stemMarkdown: '阅读这段程序中的公共材料',
    answerMarkdown: '',
    explanationMarkdown: '',
    parts: [
      {
        id: 'p1',
        title: '第一个问题',
        type: 'true_false',
        stemMarkdown: '判断第一个结论',
        answerMarkdown: '第一个解答',
        explanationMarkdown: '第一处分析',
        options: [],
        correctAnswers: ['true'],
      },
      {
        id: 'p2',
        title: '第二个问题',
        type: 'true_false',
        stemMarkdown: '判断第二个结论',
        answerMarkdown: '第二个解答',
        explanationMarkdown: '第二处分析',
        options: [],
        correctAnswers: ['true'],
      },
    ],
  });
  store.put('questions', q.id, q);
  const p = paper('组合练习', [q.id]);
  submitAttempt(store, createAttempt(store, p), {
    'GROUP::p1': { value: 'false' },
    'GROUP::p2': { value: 'true' },
  });
  const packet = exportShare(store, {
    kind: 'learning',
    learning: { kind: 'wrong', source: 'paper', paperId: p.id },
  });
  assert.equal(packet.questions.length, 1);
  const shared = packet.questions[0]!;
  assert.equal(shared.type, 'true_false');
  assert.ok(shared.stemMarkdown.includes(q.stemMarkdown));
  assert.ok(shared.stemMarkdown.includes('判断第一个结论'));
  assert.ok(!shared.stemMarkdown.includes('判断第二个结论'));
  assert.equal(shared.answerMarkdown, '第一个解答');
  const target = new Store(':memory:');
  t.after(() => target.database.close());
  assert.equal(
    planShareImport(target, packet, { enabled: false }).preview.counts.questions!.added,
    1,
  );
});
test('HTTP manifest ZIP supports batch paper selection and validates special-set scope', async (t) => {
  const app = await buildApp({
    databasePath: ':memory:',
    dailyPushScheduler: false,
    logger: false,
  });
  t.after(() => app.close());
  const call = async (url: string, payload?: unknown) => {
    const r = await app.inject({
      url,
      ...(payload === undefined ? {} : { method: 'POST' as const, payload: payload as any }),
    });
    assert.ok(r.statusCode < 400, r.body);
    return r.json();
  };
  await call('/api/import', { mode: 'merge', data: learningSeed() });
  const papers = [];
  for (let i = 0; i < 2; i++)
    papers.push(
      await call('/api/papers', {
        title: 'HTTP分享 ' + i,
        mode: 'manual',
        questionIds: ['FIXTURE-BOOL'],
      }),
    );
  const file = await call('/api/packages/export', {
      kind: 'share',
      selection: { kind: 'paper', ids: papers.map((p) => p.id) },
    }),
    packet = await readDataPackage(Buffer.from(file.dataBase64, 'base64'));
  assert.equal(packet.manifest.kind, 'share');
  assert.equal((packet.payloads[0]!.data as any).papers.length, 2);
  const rejected = await app.inject({
    url: '/api/packages/export-preview',
    method: 'POST',
    payload: {
      kind: 'share',
      selection: { kind: 'learning', learning: { kind: 'wrong', source: 'paper' } },
    },
  });
  assert.equal(rejected.statusCode, 400);
});
