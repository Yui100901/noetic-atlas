import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { Store } from '../../server/core/store.js';
import { importData } from '../../server/modules/transfer/migration.js';
import { getObjectiveCorrect } from '../../shared/questions/question-utils.js';
import { planScoredQuestions } from '../../server/modules/practice/scoring.js';
import type { Question, QuestionPart, SeedData } from '../../shared/models/types.js';

const stamp = '2026-10-21T00:00:00.000Z';
function q(id: string, type: Question['type'] = 'short_answer'): Question {
  return { id, title: id, type, stemMarkdown: `题干 ${id}`, answerMarkdown: `参考 ${id}`, explanationMarkdown: `解析 ${id}`, options: [], correctAnswers: type === 'true_false' ? ['true'] : [], difficulty: 1, depth: 1, frequency: 0, frequencyScope: '', frequencyBasis: '', collection: 'general', status: 'published', categoryIds: ['base'], tagIds: ['concept'], sourceRefs: [], sourceDocument: null, sourceAnchor: null };
}
function fill(id: string) { return { ...q(id, 'fill_blank'), blanks: [{ id: 'b1', label: '协议', answers: ['TCP', '传输控制协议'], caseSensitive: false, trim: true }, { id: 'b2', label: '关键字', answers: ['Go'], caseSensitive: true, trim: false }] }; }
function group(id: string): Question {
  const first = q('part-1', 'true_false'), second = fill('part-2'), third = q('part-3', 'essay');
  const part = (q: Question): QuestionPart => ({ id: q.id, title: q.title, type: q.type as QuestionPart['type'], stemMarkdown: q.stemMarkdown, answerMarkdown: q.answerMarkdown, explanationMarkdown: q.explanationMarkdown, options: q.options, correctAnswers: q.correctAnswers, blanks: q.blanks, weight: 1 });
  return { ...q(id, 'group'), stemMarkdown: '公共程序材料：for (i=0;i<3;i++) print(i)', parts: [first, second, third].map(part) };
}
function seed(questions: Question[] = [q('A', 'true_false'), q('B'), fill('F'), q('E', 'essay'), group('G')]): SeedData {
  return { schemaVersion: 1, generatedAt: stamp, domains: [{ id: 'computer', name: '计算机', description: '', sortOrder: 0 }], categories: [{ id: 'base', domainId: 'computer', name: '通用', parentId: null, description: '', sortOrder: 0 }], tags: [{ id: 'concept', name: '概念', color: '#000', description: '', domainId: null, kind: 'method' }], questions, documents: [], papers: [{ id: 'P', title: '普通练习', mode: 'manual', description: '', filters: null, questionIds: ['A'] }] };
}
async function appFixture(t: test.TestContext) {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'not-present-v3-seed', staticRoot: 'not-present-v3-web' });
  const r = await app.inject({ method: 'POST', url: '/api/import', payload: { data: seed(), mode: 'merge' } }); assert.equal(r.statusCode, 200, r.body); t.after(() => app.close()); return app;
}
function json(r: any, status = 200): any { assert.equal(r.statusCode, status, r.body); return r.json(); }

test('paper drafts retain only three most recently saved sessions, resume same ID and never trim submitted history', async t => {
  const app = await appFixture(t), drafts: any[] = [];
  for (let n = 0; n < 3; n++) drafts.push(json(await app.inject({ method: 'POST', url: '/api/papers/P/attempts' }), 201));
  const resumed = json(await app.inject({ method: 'PUT', url: `/api/attempts/${drafts[0].id}`, payload: { answers: { A: { value: 'true' } } } })); assert.equal(resumed.id, drafts[0].id); assert.ok(resumed.updatedAt > drafts[2].updatedAt);
  const fourth = json(await app.inject({ method: 'POST', url: '/api/papers/P/attempts' }), 201);
  const recent = json(await app.inject('/api/papers/P/drafts')); assert.deepEqual(recent.map((a: any) => a.id), [fourth.id, drafts[0].id, drafts[2].id]);
  assert.equal((await app.inject(`/api/attempts/${drafts[1].id}`)).statusCode, 404);
  json(await app.inject({ method: 'POST', url: `/api/attempts/${fourth.id}/submit`, payload: { answers: { A: { value: 'true' } } } }));
  for (let n = 0; n < 4; n++) json(await app.inject({ method: 'POST', url: '/api/papers/P/attempts' }), 201);
  assert.equal(json(await app.inject('/api/papers/P/drafts')).length, 3); assert.equal(json(await app.inject(`/api/attempts/${fourth.id}`)).status, 'submitted');
  assert.equal(json(await app.inject('/api/attempts?source=paper&paperId=P&status=submitted')).length, 1);
});

test('quick practice creates no paper, respects published filters/exclusion, and revealing alone never submits or marks wrong', async t => {
  const app = await appFixture(t), before = json(await app.inject('/api/papers')).length;
  const a = json(await app.inject({ method: 'POST', url: '/api/quick-practice', payload: { filters: { domainId: 'computer', categoryId: 'base', tagIds: ['concept'], types: ['true_false'] } } }), 201);
  assert.equal(a.source, 'quick'); assert.equal(a.paperId, 'quick-practice'); assert.equal(a.scoring.enabled, false); assert.equal(a.questions[0].answerMarkdown, undefined);
  assert.equal(json(await app.inject('/api/papers')).length, before);
  assert.equal((await app.inject({ method: 'POST', url: '/api/quick-practice', payload: { filters: { types: ['true_false'] }, excludeQuestionId: 'A' } })).statusCode, 422);
  const reveal = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/reveal` })); assert.equal(reveal.status, 'in_progress'); assert.ok(reveal.referenceViewedAt); assert.equal(reveal.questions[0].answerMarkdown, '参考 A');
  assert.equal(json(await app.inject('/api/questions/A')).study.wrongCount, 0);
  const done = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { A: { value: 'false' } } } })); assert.equal(done.referenceViewedAt, reveal.referenceViewedAt); assert.equal(json(await app.inject('/api/questions/A')).study.wrongCount, 1);
  const paperAttempt = json(await app.inject({ method: 'POST', url: '/api/papers/P/attempts' }), 201); assert.equal((await app.inject({ method: 'POST', url: `/api/attempts/${paperAttempt.id}/reveal` })).statusCode, 409);
  assert.equal(json(await app.inject('/api/attempts?source=quick&status=submitted')).length, 1);
  const pending = json(await app.inject({ method: 'POST', url: '/api/questions', payload: q('PENDING', 'true_false') }), 201); assert.equal((await app.inject({ method: 'POST', url: '/api/quick-practice', payload: { questionId: pending.id } })).statusCode, 400);
});

test('fill blank matching is ordered and literal with explicit trim/case rules and no partial credit', async t => {
  const question = fill('F');
  assert.equal(getObjectiveCorrect(question, { value: [' tcp ', 'Go'] }), true);
  assert.equal(getObjectiveCorrect(question, { value: ['传输控制协议', 'Go'] }), true);
  for (const value of [['TCP', 'go'], ['TCP', ' Go'], ['Go', 'TCP'], ['TCP'], ['', 'Go']]) assert.equal(getObjectiveCorrect(question, { value }), false);
  const app = await appFixture(t); const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '填空测试', mode: 'manual', questionIds: ['F'], scoring: { enabled: true, questionPoints: { F: 2 } } } }), 201);
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201);
  assert.equal(a.questions[0].blanks[0].answers, undefined);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}`, payload: { answers: { F: { value: 'TCP' } } } })).statusCode, 400);
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { F: { value: [' TCP ', 'Go'] } } } })); assert.equal(submitted.objectiveScore, 2); assert.deepEqual(submitted.questions[0].blanks[0].answers, ['TCP', '传输控制协议']);
});

test('group leaves keep common material, independent answers, exact cents and parent study aggregation', async t => {
  const app = await appFixture(t); const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '程序材料', mode: 'manual', questionIds: ['G'], scoring: { enabled: true, questionPoints: { G: 10 }, totalPoints: 10 } } }), 201);
  assert.equal(p.questionCount, 1); assert.equal(p.answerCount, 3); assert.deepEqual(p.questions.map((q: any) => q.points), [3.34, 3.33, 3.33]); assert.equal(p.scoring.objectivePoints, 6.67); assert.equal(p.questions[1].sourceQuestionId, 'G');
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201); assert.equal(a.questions[1].groupStemMarkdown, group('G').stemMarkdown); assert.equal(a.questions[1].blanks[0].answers, undefined);
  const answers = { 'G::part-1': { value: 'false' }, 'G::part-2': { value: ['wrong', 'Go'] }, 'G::part-3': { value: '长篇说明' } };
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers } })); assert.equal(submitted.objectiveScore, 0); assert.equal(submitted.pendingSubjectiveCount, 1); assert.equal(json(await app.inject('/api/questions/G')).study.wrongCount, 1);
  const reviewed = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'G::part-3': 3.25 }, mastery: { 'G::part-1': 1, 'G::part-2': 3, 'G::part-3': 2 } } })); assert.equal(reviewed.totalScore, 3.25); assert.equal(json(await app.inject('/api/questions/G')).study.mastery, 1);
  const backup = json(await app.inject('/api/export')); assert.equal(backup.reviews.length, 1); assert.equal(backup.reviews[0].questionId, 'G');
  const tiny = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '分值舍入', mode: 'manual', questionIds: ['G'], scoring: { enabled: true, questionPoints: { G: 0.01 } } } }), 201); assert.deepEqual(tiny.questions.map((q: any) => q.points), [0.01, 0, 0]);
});

test('new types and group structure are validated and all newly added questions still require user review', async t => {
  const app = await appFixture(t);
  for (const item of [fill('NEW-F'), q('NEW-E', 'essay'), group('NEW-G')]) { const result = json(await app.inject({ method: 'POST', url: '/api/questions', payload: item }), 201); assert.equal(result.status, 'pending'); }
  const invalid = [ { ...fill('BAD-EMPTY'), blanks: [] }, { ...group('BAD-NEST'), parts: [group('nested'), q('x')] }, { ...group('BAD-WEIGHT'), parts: group('G').parts!.map(p => ({ ...p, weight: 0 })) }, { ...q('BAD-PARTS'), parts: group('G').parts } ];
  for (const item of invalid) assert.equal((await app.inject({ method: 'POST', url: '/api/questions', payload: item })).statusCode, 400);
});

test('group and blank exports isolate references in blank mode and preserve historical completed answers', async t => {
  const app = await appFixture(t); const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '组合导出', mode: 'manual', questionIds: ['G', 'F'], scoring: { enabled: false } } }), 201);
  const blank = json(await app.inject(`/api/papers/${p.id}/export-document?mode=blank`)); assert.equal(blank.questions.length, 4); assert.ok(blank.markdown.includes('公共程序材料')); assert.ok(blank.markdown.includes('协议：________________')); assert.ok(!JSON.stringify(blank).includes('传输控制协议')); assert.ok(!JSON.stringify(blank).includes('参考 part-3'));
  const answers = json(await app.inject(`/api/papers/${p.id}/export-document?mode=answers`)); assert.ok(answers.markdown.includes('传输控制协议')); assert.ok(answers.markdown.includes('参考 part-3'));
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201); json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { F: { value: ['TCP', 'Go'] }, 'G::part-3': { value: 'essay body' } } } }));
  const completed = json(await app.inject(`/api/attempts/${a.id}/export-document`)); assert.equal(completed.summary.objectiveCount, 3); assert.equal(completed.questions[2].correct, null); assert.equal(completed.questions[2].userAnswer, 'essay body'); assert.equal(completed.questions[3].correct, true);
});

test('new objective/essay/mixed group random planning matches exhaustive optimal ratios at exact total and count', () => {
  const pool = [fill('F1'), fill('F2'), q('E1', 'essay'), group('G1'), q('A1', 'true_false'), q('S1')];
  const scores = { fill_blank: 2, essay: 4, group: 3, true_false: 1, short_answer: 3 }, objective = (q: Question) => q.type === 'group' ? 2 : ['essay','short_answer'].includes(q.type) ? 0 : scores[q.type as keyof typeof scores];
  for (let total = 1; total <= 13; total++) for (const count of [undefined, 1, 2, 3]) {
    const feasible = Array.from({ length: 1 << pool.length }, (_, mask) => pool.filter((_q, i) => mask & (1 << i))).filter(items => items.length && (count === undefined || items.length === count) && items.reduce((n, q) => n + scores[q.type as keyof typeof scores], 0) === total);
    if (!feasible.length) { assert.throws(() => planScoredQuestions(pool, { enabled: true, totalPoints: total, pointsByType: scores }, count), /精确总分/); continue; }
    const plan = planScoredQuestions(pool, { enabled: true, totalPoints: total, pointsByType: scores }, count), selected = pool.filter(q => plan.questionIds!.includes(q.id));
    assert.equal(new Set(plan.questionIds).size, plan.questionIds!.length); assert.equal(selected.reduce((n, q) => n + scores[q.type as keyof typeof scores], 0), total);
    const actual = Math.abs(selected.reduce((n, q) => n + objective(q), 0) / total * 100 - 60), best = Math.min(...feasible.map(items => Math.abs(items.reduce((n, q) => n + objective(q), 0) / total * 100 - 60))); assert.ok(Math.abs(actual - best) < 1e-8);
  }
});

test('full migration retains quick/paper source, group leaves and reveal marker while rejecting forged context atomically', async t => {
  const app = await appFixture(t); const a = json(await app.inject({ method: 'POST', url: '/api/quick-practice', payload: { questionId: 'G' } }), 201); json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/reveal` }));
  const data = json(await app.inject('/api/export')); const restored = new Store(':memory:'); t.after(() => restored.db.close()); importData(restored, data);
  const migrated: any = restored.require('attempts', a.id); assert.equal(migrated.source, 'quick'); assert.ok(migrated.referenceViewedAt); assert.equal(migrated.questions[0].sourceQuestionId, 'G');
  for (const mutate of [(copy: any) => { copy.attempts[0].paperId = 'P'; }, (copy: any) => { copy.attempts[0].source = 'paper'; }, (copy: any) => { copy.attempts[0].questions[0].sourceQuestionId = 'A'; }, (copy: any) => { copy.attempts[0].questions[1].partIndex = 0; }, (copy: any) => { copy.attempts[0].questions[1].groupStemMarkdown = '伪造公共材料'; }]) {
    const empty = new Store(':memory:'); try { const corrupt = structuredClone(data); mutate(corrupt); assert.throws(() => importData(empty, corrupt)); assert.equal(empty.all('questions').length, 0); } finally { empty.db.close(); }
  }
});

test('material groups obey 500 answer slots in manual creation, exact random planning and full migration', async t => {
  const wideGroup = (id: string, length: number): Question => ({ ...group(id), parts: Array.from({ length }, (_, i) => ({ ...group(id).parts![0]!, id: `p${i}`, weight: 1 })) });
  const wide = Array.from({ length: 17 }, (_, i) => wideGroup(`W${i}`, 30)), narrow = Array.from({ length: 3 }, (_, i) => wideGroup(`N${i}`, 2)), plain = Array.from({ length: 20 }, (_, i) => q(`Q${i}`, 'true_false'));
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'not-present-v3', staticRoot: 'not-present-v3' }); t.after(() => app.close());
  json(await app.inject({ method: 'POST', url: '/api/import', payload: { data: { ...seed([...wide, ...narrow, ...plain]), papers: [] }, mode: 'merge' } }));
  const invalid = await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '超出叶子上限', mode: 'manual', questionIds: wide.map(q => q.id), scoring: { enabled: false } } });
  const large=json(invalid,201);assert.equal(large.answerCount,510);assert.equal((await app.inject({method:'POST',url:`/api/papers/${large.id}/attempts`})).statusCode,422);
  const boundary = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '恰好500项', mode: 'manual', questionIds: [...wide.slice(0, 16), ...plain].map(q => q.id), scoring: { enabled: false } } }), 201); assert.equal(boundary.answerCount, 500);
  const answers = Object.fromEntries(boundary.questions.map((q: any) => [q.id, { value: 'true' }]));
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${boundary.id}/attempts` }), 201); assert.equal(json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers } })).status, 'submitted');
  for (const count of [undefined, 17]) {
    const plan = planScoredQuestions([...wide, ...narrow], { enabled: true, totalPoints: 17, objectivePercent: 100, pointsByType: { group: 1 } }, count);
    const selected = [...wide, ...narrow].filter(q => plan.questionIds!.includes(q.id)); assert.equal(selected.length, 17); assert.ok(selected.reduce((n, q) => n + q.parts!.length, 0) <= 500);
    assert.throws(() => planScoredQuestions(wide, { enabled: true, totalPoints: 17, pointsByType: { group: 1 } }, count), /精确总分/);
  }
  const data: any = seed([...wide, ...narrow, ...plain]); data.papers = [{ id: 'BAD', title: '非法迁移', description: '', mode: 'manual', questionIds: wide.map(q => q.id), snapshot: wide }];
  const empty = new Store(':memory:'); try { assert.doesNotThrow(() => importData(empty, data)); assert.equal(empty.require<any>('papers','BAD').questionCount,wide.length); } finally { empty.db.close(); }
});

test('fractional weighted mixed groups and every new type match an independent exhaustive optimum', () => {
  const c = (id: string, type: 'single_choice' | 'multiple_choice') => ({ ...q(id, type), options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctAnswers: type === 'single_choice' ? ['A'] : ['A', 'B'] });
  const g1 = group('G1'); g1.parts = g1.parts!.map((p, i) => ({ ...p, weight: [3, 1, 2][i]! }));
  const g2 = group('G2'); g2.parts = [g2.parts![0]!, g2.parts![2]!];
  const pool = [fill('F'), q('E', 'essay'), q('S'), q('A', 'true_false'), c('C', 'single_choice'), c('M', 'multiple_choice'), g1, g2];
  // Independent cent oracle: G1's five cents split 2/1/2 by weights 3/1/2;
  // G2 splits 3/2 by equal weights. Both carry three objective cents.
  const values = [2, 7, 3, 1, 3, 4, 5, 5], objectives = [2, 0, 0, 1, 3, 4, 3, 3];
  const subsets = Array.from({ length: 1 << pool.length }, (_, mask) => { const indexes = pool.flatMap((_q, i) => mask & (1 << i) ? [i] : []); return { indexes, total: indexes.reduce((n, i) => n + values[i]!, 0), objective: indexes.reduce((n, i) => n + objectives[i]!, 0) }; });
  const scores = { fill_blank: .02, essay: .07, short_answer: .03, true_false: .01, single_choice: .03, multiple_choice: .04, group: .05 };
  for (let total = 1; total <= 24; total++) for (const count of [undefined, 1, 2, 3, 4]) for (const objectivePercent of [0, 25, 60, 100]) {
    const feasible = subsets.filter(s => s.indexes.length && s.total === total && (count === undefined || s.indexes.length === count));
    const input = { enabled: true, totalPoints: total / 100, pointsByType: scores, objectivePercent };
    if (!feasible.length) { assert.throws(() => planScoredQuestions(pool, input, count), /精确总分/); continue; }
    const result = planScoredQuestions(pool, input, count), indexes = result.questionIds!.map(id => pool.findIndex(q => q.id === id));
    assert.equal(new Set(indexes).size, indexes.length); assert.equal(indexes.reduce((n, i) => n + values[i]!, 0), total); if (count !== undefined) assert.equal(indexes.length, count);
    const distance = Math.abs(indexes.reduce((n, i) => n + objectives[i]!, 0) / total * 100 - objectivePercent), best = Math.min(...feasible.map(s => Math.abs(s.objective / total * 100 - objectivePercent)));
    assert.ok(Math.abs(distance - best) < 1e-8, `total=${total},count=${count},objective=${objectivePercent}`);
  }
});

test('legacy graded and draft snapshots without new source/time/scoring fields migrate and keep their own content', async t => {
  const app = await appFixture(t), p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '旧卷', mode: 'manual', questionIds: ['A', 'B'], scoring: { enabled: true, questionPoints: { A: 1, B: 3 } } } }), 201);
  const draft = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201); json(await app.inject({ method: 'PUT', url: `/api/attempts/${draft.id}`, payload: { answers: { B: { value: '未完的旧答案' } } } }));
  const graded = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201); json(await app.inject({ method: 'POST', url: `/api/attempts/${graded.id}/submit`, payload: { answers: { A: { value: 'true' }, B: { value: '已评旧答案' } } } })); json(await app.inject({ method: 'PUT', url: `/api/attempts/${graded.id}/review`, payload: { scores: { B: 2 } } }));
  const data = json(await app.inject('/api/export')); for (const p of data.papers) delete p.scoring; for (const a of data.attempts) for (const key of ['source', 'updatedAt', 'referenceViewedAt', 'scoring']) delete a[key];
  data.questions.find((q: any) => q.id === 'B').answerMarkdown = '新版答案不能覆盖快照';
  const restored = await buildApp({ databasePath: ':memory:', seedPath: 'not-present-v3-legacy', staticRoot: 'not-present-v3' }); t.after(() => restored.close());
  json(await restored.inject({ method: 'POST', url: '/api/import', payload: { data, mode: 'merge' } }));
  const old = json(await restored.inject(`/api/attempts/${graded.id}`)); assert.equal(old.source, 'paper'); assert.equal(old.totalScore, 3); assert.equal(old.scoring.scheme, 'legacy'); assert.equal(old.questions[1].answerMarkdown, '参考 B');
  const saved = json(await restored.inject({ method: 'PUT', url: `/api/attempts/${draft.id}`, payload: { answers: { B: { value: '继续旧草稿' } } } })); assert.equal(saved.id, draft.id); assert.equal(saved.answers.B.value, '继续旧草稿'); assert.ok(saved.updatedAt > draft.startedAt);
  const done = json(await restored.inject({ method: 'POST', url: `/api/attempts/${draft.id}/submit`, payload: {} })); assert.equal(done.questions[1].answerMarkdown, '参考 B'); assert.equal(done.pendingSubjectiveCount, 1);
});
