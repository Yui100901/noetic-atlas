import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import { parse, questionSchema } from '../../server/core/validation.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import type { Question, QuestionType } from '../../shared/models/types.js';

const stamp = '2026-10-23T00:00:00.000Z', reference = 'REFERENCE_ONLY_NOT_FOR_UNSUBMITTED';
const responseJson = (reply: { statusCode: number; json(): any }, status = 200) => { assert.equal(reply.statusCode, status, JSON.stringify(reply.json())); return reply.json(); };
async function fixture(t: test.TestContext) {
  let database: DatabaseConnection | undefined;
  const original = DatabaseConnection.prototype.all;
  const capture = t.mock.method(DatabaseConnection.prototype, 'all', function (this: DatabaseConnection, query: Parameters<typeof original>[0]) { database ||= this; return original.call(this, query); });
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'test-results/no-read-models-seed.json', staticRoot: 'test-results/no-read-models-web' });
  capture.mock.restore(); t.after(() => app.close()); assert.ok(database);
  return { app, database };
}
function question(id: string, type: QuestionType = 'short_answer', status: Question['status'] = 'published', collection: Question['collection'] = 'general'): Question {
  return { ...parse(questionSchema, {
    id, title: id, type, status, collection, stemMarkdown: '用于检验读取边界的公开题干。', answerMarkdown: reference + ' reference'.repeat(500), explanationMarkdown: reference + ' explanation'.repeat(500),
    ...(type === 'single_choice' ? { options: [{ key: 'A', text: '选项一' }, { key: 'B', text: '选项二' }], correctAnswers: ['A'] } : {}),
    ...(type === 'true_false' ? { correctAnswers: ['true'] } : {}),
    ...(type === 'fill_blank' ? { blanks: [{ id: 'gap', label: '方法名', answers: [reference], caseSensitive: false, trim: true }] } : {}),
    sourceRefs: [{ label: '参考', url: 'https://example.test/reference' }],
  }), id, createdAt: stamp, updatedAt: stamp } as Question;
}
function paper(id: string, questions: Question[], extra: Record<string, unknown> = {}) {
  return { id, title: id, mode: 'manual', description: '通用练习卷', questionIds: questions.map(q => q.id), questionCount: questions.length, snapshot: questions.map(q => ({ ...q, resumePriority: 'retired' })), filters: { collection: 'personal', priority: 'retired' }, organization: 'other', domainId: null, archived: false, version: 1, createdAt: stamp, updatedAt: stamp, scoring: normalizeScoring(questions, { enabled: false }), ...extra };
}
function attempt(id: string, questions: Question[], extra: Record<string, unknown> = {}) {
  return { id, source: 'paper', paperId: 'paper-1', paperTitle: '通用练习卷', paperVersion: 1, status: 'in_progress', questions: questions.map(q => ({ ...q, resumePriority: 'retired' })), answers: Object.fromEntries(questions.map(q => [q.id, { value: q.type === 'fill_blank' ? ['用户填空'] : '用户回答中的 priority 和 resumePriority 字样应保留' }])), objectiveScore: 0, objectiveMax: 0, subjectiveScore: 0, subjectiveMax: 0, scoring: normalizeScoring(questions, { enabled: false }), startedAt: stamp, updatedAt: stamp, submittedAt: null, ...extra };
}
interface Reads { calls: number; dataBytes: number; questionBodies: number; paperBodies: number; paperQuestionBodies: number; attemptBodies: number; documentBodies: number; studyNotes: number }
async function observed<T>(database: DatabaseConnection, action: () => Promise<T>) {
  const all = database.all.bind(database), one = database.one.bind(database), reads: Reads = { calls: 0, dataBytes: 0, questionBodies: 0, paperBodies: 0, paperQuestionBodies: 0, attemptBodies: 0, documentBodies: 0, studyNotes: 0 };
  const record = (rows: unknown[]) => {
    reads.calls++;
    for (const row of rows) if (row && typeof row === 'object' && 'data' in row && typeof row.data === 'string') {
      reads.dataBytes += Buffer.byteLength(row.data); const value = JSON.parse(row.data);
      if (Array.isArray(value.snapshot)) { reads.paperBodies++; if (value.snapshot.some((q: Record<string, unknown>) => 'stemMarkdown' in q || 'answerMarkdown' in q)) reads.paperQuestionBodies++; }
      else if (Array.isArray(value.questions)) reads.attemptBodies++;
      else if ('stemMarkdown' in value) reads.questionBodies++;
      else if ('bodyMarkdown' in value) reads.documentBodies++;
      else if ('notes' in value && 'favorite' in value) reads.studyNotes++;
    }
  };
  database.all = ((query: Parameters<typeof all>[0]) => { const rows = all(query); record(rows); return rows; }) as typeof database.all;
  database.one = ((query: Parameters<typeof one>[0]) => { const row = one(query); record(row ? [row] : []); return row; }) as typeof database.one;
  try { return { value: await action(), reads }; }
  finally { database.all = all; database.one = one; }
}

test('bootstrap aggregates metadata without decoding question, paper, document or study-note bodies', async t => {
  const { app, database } = await fixture(t);
  const questions = [question('Q0', 'true_false'), question('Q1', 'short_answer', 'published', 'personal'), question('Q2', 'single_choice'), question('Q3', 'short_answer', 'pending'), question('Q4', 'short_answer', 'draft'), question('Q5', 'short_answer', 'archived')];
  for (const q of questions) database.putRecord('questions', q.id, q);
  for (const [index, q] of questions.entries()) database.putRecord('study', q.id, { questionId: q.id, favorite: index !== 2, mastery: null, notes: 'PRIVATE_STUDY_NOTES'.repeat(2000), nextReviewAt: index === 1 ? '2999-01-01T00:00:00.000Z' : index === 2 ? null : '2000-01-01T00:00:00.000Z', lastReviewedAt: null, wrongCount: index === 0 || index >= 3 ? 2 : 0 });
  database.putRecord('study', 'orphan', { questionId: 'orphan', favorite: true, notes: 'PRIVATE_ORPHAN', nextReviewAt: stamp, wrongCount: 5 });
  for (let index = 0; index < 4; index++) { const value: any = paper(`P${index}`, questions.slice(0, 3), { archived: index === 1 }); if (index === 3) delete value.archived; database.putRecord('papers', value.id, value); }
  for (let index = 0; index < 4; index++) database.putRecord('documents', `D${index}`, { id: `D${index}`, title: '资料', bodyMarkdown: 'PRIVATE_DOCUMENT_BODY'.repeat(2000), ...(index === 3 ? {} : { _archived: index === 1 }) });
  database.projections.refreshAll();
  const { value, reads } = await observed(database, async () => responseJson(await app.inject('/api/bootstrap')));
  assert.deepEqual(value.stats, { totalQuestions: 3, generalQuestions: 2, personalQuestions: 1, totalPapers: 3, totalDocuments: 3, favoriteCount: 2, dueCount: 1, wrongCount: 1, typeCounts: { true_false: 1, short_answer: 1, single_choice: 1 }, domainQuestionCounts: {} });
  for (const kind of ['questionBodies', 'paperBodies', 'paperQuestionBodies', 'attemptBodies', 'documentBodies', 'studyNotes'] as const) assert.equal(reads[kind], 0, kind);
  assert.ok(reads.dataBytes < 20_000); assert.doesNotMatch(JSON.stringify(value), /REFERENCE_ONLY|PRIVATE_STUDY|PRIVATE_DOCUMENT|PRIVATE_ORPHAN/);
  t.diagnostic(JSON.stringify({ bootstrapReads: reads }));
});

test('domain overview counts published and pending questions once per domain with current classification', async t => {
  const {app,database}=await fixture(t);
  for(const id of ['D1','D2','EMPTY'])database.putRecord('domains',id,{id,name:id,description:'',sortOrder:0});
  const category=(id:string,domainId:string,parentId:string|null=null)=>database.putRecord('categories',id,{id,domainId,parentId,name:id,description:'',sortOrder:0});
  category('C1','D1');category('C2','D1','C1');category('C3','D2');
  for(const [id,status,categoryIds] of [
    ['SHARED','published',['C1','C2','C3']],['CHILD','published',['C2']],['PENDING','pending',['C1']],
    ['DRAFT','draft',['C1']],['ARCHIVED','archived',['C1']],['UNCLASSIFIED','published',[]],
  ] as const)database.putRecord('questions',id,{...question(id,'short_answer',status),categoryIds:[...categoryIds]});
  database.projections.refreshAll();
  const read=()=>observed(database,async()=>responseJson(await app.inject('/api/bootstrap')));
  const first=await read();
  assert.equal(first.value.stats.totalQuestions,3);
  assert.deepEqual(first.value.stats.domainQuestionCounts,{D1:{published:2,pending:1},D2:{published:1,pending:0}});
  assert.equal(first.reads.questionBodies,0);
  category('C2','D2');
  const moved=await read();
  assert.deepEqual(moved.value.stats.domainQuestionCounts,{D1:{published:1,pending:1},D2:{published:2,pending:0}});
  assert.equal(moved.reads.questionBodies,0);
});

test('paper list decodes only its page, hides snapshots, strips retired fields and keeps unpaged/include-all contracts', async t => {
  const { app, database } = await fixture(t), q = question('Q-personal', 'short_answer', 'published', 'personal'), records: ReturnType<typeof paper>[] = [];
  for (let index = 0; index < 26; index++) {
    const value: any = paper(`P${String(index).padStart(2, '0')}`, [q], { archived: index % 5 === 0, organization: index % 3 === 0 ? 'domain' : 'other', domainId: index % 3 === 0 ? 'computer' : null, updatedAt: new Date(Date.parse(stamp) - Math.floor(index / 2) * 1000).toISOString() });
    if (index === 1) delete value.organization;
    if (index === 2) { delete value.organization; delete value.archived; }
    database.putRecord('papers', value.id, value); records.push(value);
  }
  const expected = records.filter(p => !p.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  database.projections.ensure(['papers']);
  const { value, reads } = await observed(database, async () => responseJson(await app.inject('/api/papers?page=2&pageSize=10')));
  assert.equal(value.total, 20); assert.deepEqual(value.items.map((item: any) => item.id), expected.slice(10, 20).map(item => item.id));
  assert.equal(reads.paperBodies, 10); assert.equal(reads.paperQuestionBodies, 0); assert.equal(reads.questionBodies, 0); assert.equal(reads.attemptBodies, 0); assert.ok(reads.dataBytes < 20_000);
  for (const item of value.items) { assert.equal(item.snapshot, undefined); assert.equal(item.questions, undefined); assert.equal(item.filters.priority, undefined); assert.equal(item.filters.collection, 'personal'); }
  assert.doesNotMatch(JSON.stringify(value), /REFERENCE_ONLY|resumePriority/);
  const all = responseJson(await app.inject('/api/papers')); assert.ok(Array.isArray(all)); assert.equal(all.length, 20);
  assert.equal(responseJson(await app.inject('/api/papers?archived=true&pageSize=10')).total, 26);
  assert.equal(responseJson(await app.inject('/api/papers?archived=false&pageSize=10')).total, 20);
  const other = responseJson(await app.inject('/api/papers?organization=other')); assert.ok(other.some((item: any) => item.id === 'P01')); assert.ok(other.some((item: any) => item.id === 'P02'));
  const domain = responseJson(await app.inject('/api/papers?organization=domain&domainId=computer')); assert.ok(domain.length); assert.ok(domain.every((item: any) => item.organization === 'domain' && item.domainId === 'computer'));
  assert.deepEqual(responseJson(await app.inject('/api/papers?page=100&pageSize=10')).items, []);
  assert.equal(database.getRecord<any>('papers', 'P01').filters.priority, 'retired');
  t.diagnostic(JSON.stringify({ paperPageReads: reads }));
});

test('attempt list pages retain response privacy, revealed quick references, legacy source and retired-field cleanup', async t => {
  const { app, database } = await fixture(t), questions = [question('TF', 'true_false'), question('GAP', 'fill_blank'), question('SA')], records: ReturnType<typeof attempt>[] = [];
  for (let index = 0; index < 26; index++) {
    const submitted = index % 2 !== 0, value: any = attempt(`A${String(index).padStart(2, '0')}`, questions, { source: index % 3 === 0 ? 'quick' : 'paper', paperId: index % 4 === 0 ? 'paper-2' : 'paper-1', status: submitted ? 'submitted' : 'in_progress', submittedAt: submitted ? stamp : null, updatedAt: new Date(Date.parse(stamp) - index * 1000).toISOString(), ...(index === 6 ? { referenceViewedAt: stamp } : {}) });
    if (index === 2) { delete value.source; delete value.updatedAt; }
    database.putRecord('attempts', value.id, value); records.push(value);
  }
  const expected = records.slice().sort((a, b) => (b.updatedAt || b.startedAt).localeCompare(a.updatedAt || a.startedAt) || b.id.localeCompare(a.id));
  const { value, reads } = await observed(database, async () => responseJson(await app.inject('/api/attempts?page=2&pageSize=10')));
  assert.equal(value.total, 26); assert.deepEqual(value.items.map((item: any) => item.id), expected.slice(10, 20).map(item => item.id)); assert.equal(reads.attemptBodies, 10); assert.equal(reads.paperBodies, 0); assert.equal(reads.questionBodies, 0);
  const all = responseJson(await app.inject('/api/attempts')); assert.ok(Array.isArray(all)); assert.equal(all.length, 26);
  for (const item of all) {
    const revealed = item.status === 'submitted' || item.source === 'quick' && item.referenceViewedAt;
    assert.equal(JSON.stringify(item).includes('"resumePriority"'), false);
    assert.match(item.answers.SA.value, /priority 和 resumePriority/);
    for (const q of item.questions) {
      assert.equal(q.sourceDocument, undefined);
      if (revealed) { assert.ok(q.answerMarkdown.includes(reference)); assert.ok(q.explanationMarkdown.includes(reference)); assert.ok(q.sourceRefs.length); }
      else { for (const key of ['answerMarkdown', 'explanationMarkdown', 'correctAnswers', 'sourceRefs']) assert.equal(q[key], undefined, `${item.id}.${q.id}.${key}`); }
    }
    assert.equal(item.questions.find((q: any) => q.id === 'GAP').blanks[0].answers?.[0], revealed ? reference : undefined);
  }
  const legacy = all.find((item: any) => item.id === 'A02'); assert.equal(legacy.source, 'paper'); assert.equal(legacy.updatedAt, legacy.startedAt);
  const filtered = responseJson(await app.inject('/api/attempts?paperId=paper-1&source=paper&status=in_progress&pageSize=10'));
  const filteredExpected = expected.filter(item => item.paperId === 'paper-1' && (item.source || 'paper') === 'paper' && item.status === 'in_progress');
  assert.equal(filtered.total, filteredExpected.length); assert.deepEqual(filtered.items.map((item: any) => item.id), filteredExpected.slice(0, 10).map(item => item.id));
  assert.ok(filtered.items.some((item: any) => item.id === 'A02'));
  assert.deepEqual(responseJson(await app.inject('/api/attempts?page=100&pageSize=10')).items, []);
  assert.equal(database.getRecord<any>('attempts', 'A02').questions[0].resumePriority, 'retired');
  t.diagnostic(JSON.stringify({ attemptPageReads: reads }));
});

test('same-time history IDs preserve locale order across page boundaries while bodies stay page-local', async t => {
  const { app, database } = await fixture(t), q = question('Q'), ids = ['a', 'A', 'a-1', 'a_1', '甲', '乙', 'Z', 'z', 'a.1', 'a:1', 'x', 'X', 'b', 'B'];
  for (const id of ids) database.putRecord('attempts', id, attempt(id, [q]));
  const expected = ids.slice().sort((a, b) => b.localeCompare(a));
  const first = await observed(database, async () => responseJson(await app.inject('/api/attempts?page=1&pageSize=10')));
  const second = responseJson(await app.inject('/api/attempts?page=2&pageSize=10'));
  assert.deepEqual([...first.value.items, ...second.items].map((item: any) => item.id), expected);
  assert.equal(first.reads.attemptBodies, 10); assert.equal(first.value.total, ids.length); assert.equal(second.total, ids.length);
  assert.deepEqual(responseJson(await app.inject('/api/attempts')).map((item: any) => item.id), expected);
});

test('paper summaries retain mixed-group weight scoring and still reject inconsistent score snapshots', async t => {
  const { app, database } = await fixture(t);
  const group = { ...parse(questionSchema, { id: 'GROUP', title: '组合材料', type: 'group', stemMarkdown: '公共题干', parts: [
    { id: 'choice', title: '选择', type: 'single_choice', stemMarkdown: '选择答案', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }], correctAnswers: ['A'], weight: 1 },
    { id: 'why', title: '解释', type: 'short_answer', stemMarkdown: '说明理由', answerMarkdown: reference, weight: 2 },
  ] }), id: 'GROUP' } as Question;
  const scoring = normalizeScoring([group], { enabled: true, totalPoints: 7, questionPoints: { GROUP: 7 } }), original = paper('mixed-group', [group], { scoring });
  database.putRecord('papers', original.id, original);
  const result = responseJson(await app.inject('/api/papers?pageSize=10'));
  assert.equal(result.items[0].scoring.objectivePoints, 2.33); assert.equal(result.items[0].scoring.subjectivePoints, 4.67); assert.equal(result.items[0].scoring.totalPoints, 7);
  const changed = structuredClone(original); changed.snapshot[0]!.parts![0]!.weight = 2;
  database.putRecord('papers', changed.id, changed);
  assert.equal(responseJson(await app.inject('/api/papers?pageSize=10'), 400).error.code, 'INVALID_SCORING_SNAPSHOT');
});
