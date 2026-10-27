import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Question } from '../../shared/models/types.js';
import type { QualityIssue, QualityScan } from '../../shared/models/content-quality.js';
import { Store, now, nextStamp } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerContentQualityRoutes } from '../../server/modules/content-quality/routes.js';
import { inspectQuestionQuality, qualityContentFingerprint, qualitySignatures } from '../../server/modules/content-quality/rules.js';
import { qualityIssueSchema, qualityScanSchema } from '../../server/modules/content-quality/schema.js';
import { createQualityScan, processQualityScan, qualityIssueDetail } from '../../server/modules/content-quality/service.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

function q(id = 'Q1', changes: Record<string, unknown> = {}): Question { return parse(questionSchema, { id, title: '事务原子性', type: 'short_answer', stemMarkdown: '说明事务原子性。', answerMarkdown: '事务整体提交或回滚。', explanationMarkdown: '部分操作失败时回滚，防止中间结果被保留。', categoryIds: ['cs-cat'], sourceRefs: [{ label: '原创教学示例', url: 'https://www.postgresql.org/docs/current/tutorial-transactions.html' }], status: 'published', createdAt: now(), updatedAt: now(), ...changes }); }
async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  for (const did of ['cs', 'en']) { store.put('domains', did, { id: did, name: did, description: '', sortOrder: 0 }); store.put('categories', did + '-cat', { id: did + '-cat', domainId: did, parentId: null, name: did, description: '', sortOrder: 0 }); }
  store.put('categories', 'cs-leaf', { id: 'cs-leaf', domainId: 'cs', parentId: 'cs-cat', name: '子类', description: '', sortOrder: 0 });
  store.put('tags', 'term', { id: 'term', name: '术语', color: '#123456', description: '', domainId: 'cs', kind: 'topic' });
  const app = Fastify(); app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } }) : reply.code(500).send({ error: { code: 'TEST_FAILURE', message: error.message } }));
  registerContentQualityRoutes(app, store);
  const api = async (url: string, payload?: unknown, expected = 200) => { const response = await app.inject({ url, method: payload === undefined ? 'GET' : 'POST', ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, expected, response.body); return response.json(); };
  const scan = async (filters = {}) => { let run = await api('/api/content-quality/scans', { filters }, 201); while (run.status === 'ready') run = await api(`/api/content-quality/scans/${run.id}/process`, { batchSize: 2 }); assert.equal(qualityScanSchema.safeParse(run).success, true); return run; };
  t.after(async () => { await app.close(); store.database.close(); });
  return { store, api, scan };
}

test('deterministic checks preserve code, operators, negation and source contents', () => {
  const question = q('BLANK', { type: 'fill_blank', stemMarkdown: '坐标是 {{answer}}。\n\n`{{answer}}`\n\n```ts\nconst a = "{{blank}}";\n```', blanks: [{ id: 'b1', label: '坐标', answers: ['纬度'] }] }), original = structuredClone(question);
  const found = inspectQuestionQuality(question); assert.equal(found.filter(f => f.rule === 'template_placeholder').length, 1); assert.match(found.find(f => f.rule === 'template_placeholder')!.evidence, /坐标是 \{\{answer\}\}/); assert.deepEqual(question, original);
  const codeOnly = { ...question, stemMarkdown: '`{{answer}}`\n\n    {{answer}}\n\n<pre>{{blank}}</pre>\n\n\\{\\{answer\\}\\}' }; assert.equal(inspectQuestionQuality(codeOnly).some(f => f.rule === 'template_placeholder'), false);
  const left = q('CODE1', { stemMarkdown: '```js\na + +b\n```' }), right = q('CODE2', { stemMarkdown: '```js\na++ + b\n```' }); assert.notEqual(qualitySignatures(left).promptHash, qualitySignatures(right).promptHash);
  assert.notEqual(qualitySignatures(q()).promptHash, qualitySignatures(q('Q2', { stemMarkdown: '说明非原子性事务。' })).promptHash);
  const ordered=q(), reversed=Object.fromEntries(Object.entries(ordered).reverse()) as unknown as Question;assert.equal(qualityContentFingerprint(ordered),qualityContentFingerprint(reversed),'migration may reorder object keys without changing content');
});

test('checks capture structural corruption, duplicate options, explicit contradictions and unsafe reverse concepts', () => {
  const damaged = { ...q(), options: [null], sourceRefs: 'broken', blanks: 'broken', parts: [null] } as unknown as Question;
  assert.ok(inspectQuestionQuality(damaged).some(item => item.rule === 'structure')); assert.doesNotThrow(() => qualitySignatures(damaged));
  const choice = q('CHOICE', { type: 'single_choice', options: [{ key: 'A', text: '提交' }, { key: 'B', text: '提交' }], correctAnswers: ['B'], answerMarkdown: 'B', explanationMarkdown: '正确答案为A。' });
  assert.ok(inspectQuestionQuality(choice).some(item => item.rule === 'duplicate_options')); assert.ok(inspectQuestionQuality(choice).some(item => item.rule === 'answer_explanation_conflict'));
  assert.equal(inspectQuestionQuality({...choice,options:[{key:'A',text:'    return x'},{key:'B',text:'return x'}]}).some(item=>item.rule==='duplicate_options'),false,'leading indentation in code options is significant');
  const embeddedExample = { ...choice, explanationMarkdown: '有人会误认为正确答案为A，但这是错误的。' }; assert.equal(inspectQuestionQuality(embeddedExample).some(item => item.rule === 'answer_explanation_conflict'), false, 'quoted mistaken reasoning should not count as final conclusion');
  const concept = { ...q('CONCEPT'), concept: { term: '原子性', acceptedAnswers: ['原子性', '事务原子性'], meaningPrompt: '原子性是事务全部提交或回滚的性质。' } }; assert.ok(inspectQuestionQuality(concept).some(item => item.rule === 'concept_prompt_leak'));
});

test('scan is explicit, bounded, resumable and does not modify questions or learning data', async t => {
  const f = await fixture(t); for (let index = 0; index < 7; index++) f.store.put('questions', `Q${index}`, q(`Q${index}`, { stemMarkdown: `问题${index}`, explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}], status: index % 2 ? 'pending' : 'published' }));
  f.store.put('study', 'Q0', { ...f.store.study('Q0'), notes: '学习笔记' });
  const before = { questions: f.store.database.records('questions'), study: f.store.database.records('study') };
  const originalAll = f.store.all.bind(f.store), originalRecords = f.store.database.records.bind(f.store.database); f.store.all = ((table: any) => { assert.notEqual(table, 'questions', 'cannot load all full question bodies'); return originalAll(table); }) as any; f.store.database.records = ((table: any) => { assert.notEqual(table, 'questions', 'cannot parse all question records'); return originalRecords(table); }) as any;
  assert.equal((await f.api('/api/content-quality/overview')).totalIssues, 0); assert.equal((await f.api('/api/content-quality/scans')).total, 0);
  let run = await f.api('/api/content-quality/scans', {}, 201); assert.equal(run.plannedTotal, 7); assert.equal(run.processed, 0);
  run = await f.api(`/api/content-quality/scans/${run.id}/process`, { batchSize: 2 }); assert.equal(run.processed, 2); assert.equal(run.status, 'ready');
  assert.equal((await f.api('/api/content-quality/scans/' + run.id)).processed, 2);
  while (run.status === 'ready') run = await f.api(`/api/content-quality/scans/${run.id}/process`, { batchSize: 2 }); assert.equal(run.processed, 7); assert.equal(run.status, 'completed');
  assert.equal((await f.api(`/api/content-quality/scans/${run.id}/process`, {})).processed, 7);
  f.store.database.records = originalRecords; assert.deepEqual(f.store.database.records('questions'), before.questions); assert.deepEqual(f.store.database.records('study'), before.study);
  assert.equal((await f.api('/api/content-quality/overview')).coverage.semanticVerification, 'not_performed');
});

test('scope uses domains, category descendants, tags, type, approval state and exact single question', async t => {
  const f = await fixture(t); f.store.put('questions', 'Q1', q('Q1', { categoryIds: ['cs-leaf'], tagIds: ['term'], explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}] })); f.store.put('questions', 'Q2', q('Q2', { stemMarkdown: 'Explain an English predicate.', categoryIds: ['en-cat'], explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}] })); f.store.put('questions', 'Q3', q('Q3', { status: 'pending', explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}] }));
  assert.equal((await f.scan({ domainId: 'cs', categoryId: 'cs-cat', tagIds: ['term'], type: 'short_answer', status: 'published' })).processed, 1);
  assert.equal((await f.scan({ questionId: 'Q2' })).processed, 1); assert.equal((await f.api('/api/content-quality/issues?domainId=en')).total, 1);
  await f.api('/api/content-quality/scans', { filters: { domainId: 'unknown' } }, 404); await f.api('/api/content-quality/scans', { filters: { unknown: 'bad' } }, 400);
});

test('fingerprint and rule version deduplicate findings while publication approval preserves them', async t => {
  const f = await fixture(t); const question = q('Q1', { explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}], status: 'pending' }); f.store.put('questions', 'Q1', question); await f.scan();
  let issues = (await f.api('/api/content-quality/issues')).items; assert.equal(issues.length, 1); assert.equal(qualityIssueSchema.safeParse(issues.map(({ sourceAvailable: _a, sourceChanged: _b, relatedChanged: _c, ...value }: any) => value)[0]).success, true);
  const ignored = await f.api(`/api/content-quality/issues/${issues[0].id}/resolve`, { status: 'dismissed', note: '隔离占位来源测试，暂保留后续修订。', expectedUpdatedAt: issues[0].updatedAt });
  const approved = { ...question, status: 'published', updatedAt: nextStamp(question.updatedAt) } as Question; assert.equal(qualityContentFingerprint(question), qualityContentFingerprint(approved)); f.store.put('questions', 'Q1', approved); await f.scan();
  issues = (await f.api('/api/content-quality/issues?status=all')).items; assert.equal(issues.length, 1); assert.equal(issues[0].status, 'dismissed'); assert.equal(issues[0].note, ignored.note);
  f.store.put('questions', 'Q1', { ...approved, stemMarkdown: '改变条件。', updatedAt: nextStamp(approved.updatedAt) }); assert.equal((await f.api('/api/content-quality/issues/' + issues[0].id)).issue.sourceChanged, true); await f.scan();
  assert.equal((await f.api('/api/content-quality/issues?status=all')).total, 2); assert.equal((await f.api('/api/content-quality/issues?status=open')).total, 1);
});

test('changed inputs invalidate active findings, require recheck and can become new issues', async t => {
  const f = await fixture(t); f.store.put('questions', 'Q1', q('Q1', { explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}] })); await f.scan();
  const issue = (await f.api('/api/content-quality/issues')).items[0]; f.store.put('questions', 'Q1', { ...f.store.require<Question>('questions', 'Q1'), explanationMarkdown: '答案中已含解释。', sourceRefs: [], updatedAt: now() });
  assert.equal((await f.api('/api/content-quality/issues/' + issue.id)).issue.sourceChanged, true);
  await f.api(`/api/content-quality/issues/${issue.id}/resolve`, { status: 'resolved', note: '已修改，尚未重新扫描', expectedUpdatedAt: issue.updatedAt }, 409); await f.scan();
  assert.equal((await f.api('/api/content-quality/issues?status=stale')).total, 1); assert.equal(f.store.require<Question>('questions', 'Q1').status, 'published');
  const rechecked = (await f.api('/api/content-quality/issues/' + issue.id)).issue;
  assert.equal((await f.api(`/api/content-quality/issues/${issue.id}/resolve`, { status: 'resolved', note: '已移除占位来源并对当前内容重新扫描。', expectedUpdatedAt: rechecked.updatedAt })).status, 'resolved');
});

test('exact duplicate and objective answer conflict are conservative candidates, never automatic merge or rejection', async t => {
  const f = await fixture(t), original = q('A', { type: 'single_choice', stemMarkdown: '2 + 3 * 4 等于多少？', options: [{ key: 'A', text: '14' }, { key: 'B', text: '20' }], correctAnswers: ['A'], answerMarkdown: '14', explanationMarkdown: '先乘后加。' });
  f.store.put('questions', 'A', original); f.store.put('questions', 'B', { ...original, id: 'B', title: '换名同题' }); f.store.put('questions', 'C', { ...original, id: 'C', correctAnswers: ['B'], answerMarkdown: '20', explanationMarkdown: '保存答案待核查。' }); f.store.put('questions', 'D', { ...original, id: 'D', answerMarkdown: '选项A，等于14', explanationMarkdown: '另一个正确讲法。' }); f.store.put('questions', 'E', { ...original, id: 'E', stemMarkdown: '2 + 3 * 4 不等于多少？' });
  await f.scan(); const all = (await f.api('/api/content-quality/issues?status=all&pageSize=100')).items;
  assert.ok(all.some((issue: QualityIssue) => issue.questionId === 'B' && issue.rule === 'exact_duplicate')); assert.ok(all.some((issue: QualityIssue) => issue.questionId === 'C' && issue.rule === 'conflicting_answers')); const dConflict=all.find((issue:QualityIssue)=>issue.questionId==='D'&&issue.rule==='conflicting_answers'); assert.ok(!dConflict?.relatedQuestions.some((item:any)=>['A','B'].includes(item.questionId)), 'same grading answer with different answer prose must not conflict'); assert.ok(!all.some((issue: QualityIssue) => issue.questionId === 'E' && ['conflicting_answers', 'exact_duplicate'].includes(issue.rule)));
  const detail = qualityIssueDetail(f.store, all.find((issue: QualityIssue) => issue.rule === 'conflicting_answers').id); assert.ok(detail.relatedQuestions.length); assert.equal(f.store.all('questions').length, 5); assert.ok(f.store.all<Question>('questions').every(q => q.status === 'published'));
});

test('issues paginate and bulk resolution is atomic, version checked and requires reasons', async t => {
  const f = await fixture(t); for (let index = 0; index < 23; index++) f.store.put('questions', 'Q' + index, q('Q' + index, { stemMarkdown: '唯一问题' + index, explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}] })); await f.scan();
  assert.equal((await f.api('/api/content-quality/issues?page=3&pageSize=10')).items.length, 3); await f.api('/api/content-quality/issues?pageSize=15', undefined, 400);
  const list = (await f.api('/api/content-quality/issues?pageSize=100')).items, a = list[0], b = list[1];
  await f.api(`/api/content-quality/issues/${a.id}/resolve`, { status: 'confirmed', note: '', expectedUpdatedAt: a.updatedAt }, 400);
  await f.api('/api/content-quality/issues/resolve', { ids: [a.id, b.id], status: 'confirmed', note: '逐条核对后确认', expectedUpdatedAt: { [a.id]: a.updatedAt, [b.id]: '2000-01-01T00:00:00.000Z' } }, 409); assert.equal((await f.api('/api/content-quality/issues/' + a.id)).issue.status, 'open');
  const result = await f.api('/api/content-quality/issues/resolve', { ids: [a.id, b.id], status: 'confirmed', note: '逐条核对后确认', expectedUpdatedAt: { [a.id]: a.updatedAt, [b.id]: b.updatedAt } }); assert.ok(result.items.every((issue: QualityIssue) => issue.status === 'confirmed'));
  await f.api(`/api/content-quality/issues/${a.id}/resolve`, { status: 'dismissed', note: '旧版本', expectedUpdatedAt: a.updatedAt }, 409);
  assert.equal((await f.api('/api/content-quality/issues?rule=reference_placeholder&severity=warning&search=' + encodeURIComponent('事务'))).total, 23);
});

test('cancelled tasks cannot continue and derived-index loss requires a new full scan', async t => {
  const f = await fixture(t); for (let index = 0; index < 3; index++) f.store.put('questions', 'Q' + index, q('Q' + index));
  let scan = createQualityScan(f.store, {}); scan = processQualityScan(f.store, scan.id, 1); f.store.database.deleteRecord('quality_fingerprints', 'Q0');
  const response = await f.api(`/api/content-quality/scans/${scan.id}/process`, {}, 409); assert.equal(response.error.code, 'QUALITY_REBUILD_REQUIRED'); assert.equal(f.store.database.getRecord<QualityScan>('quality_scans', scan.id)!.lastFailure!.code, 'QUALITY_REBUILD_REQUIRED');
  const retry = await f.scan(); assert.equal(retry.processed, 3);
  const pending = await f.api('/api/content-quality/scans', {}, 201); await f.api(`/api/content-quality/scans/${pending.id}/cancel`, {}); await f.api(`/api/content-quality/scans/${pending.id}/process`, {}, 409); await f.api(`/api/content-quality/scans/${pending.id}/process`, { batchSize: 201 }, 400);
});

test('missing managed assets produce evidence, and source or study changes never produce automatic expert verdicts', async t => {
  const f = await fixture(t); f.store.put('questions', 'Q1', q('Q1', { stemMarkdown: '![示意图](/api/assets/asset-absent/content)' })); await f.scan();
  const all = (await f.api('/api/content-quality/issues')).items; assert.ok(all.some((issue: QualityIssue) => issue.rule === 'structure' && issue.evidence.includes('asset-absent')));
  const before = f.store.database.records('quality_issues'); await f.api('/api/content-quality/issues'); await f.api('/api/content-quality/overview'); assert.deepEqual(f.store.database.records('quality_issues'), before);
});

test('JSON migration preserves scan evidence and human resolutions but never copies derived signatures', async t => {
  const f = await fixture(t); f.store.put('questions', 'Q1', q('Q1', { explanationMarkdown: '', sourceRefs: [{label:'待补充的占位来源',url:'https://example.org/placeholder'}] })); await f.scan();
  const issue = (await f.api('/api/content-quality/issues')).items[0], resolved = await f.api(`/api/content-quality/issues/${issue.id}/resolve`, { status: 'dismissed', note: '保留原创简答，另有课堂讲义。', expectedUpdatedAt: issue.updatedAt });
  const snapshot = exportData(f.store) as any; assert.equal(snapshot.qualityIssues[0].status, 'dismissed'); assert.equal(snapshot.qualityScans.length, 1); assert.ok(!Object.hasOwn(snapshot, 'qualityFingerprints')); assert.ok(!Object.hasOwn(snapshot, 'quality_fingerprints'));
  const target = new Store(':memory:'); t.after(() => target.database.close()); importData(target, snapshot);
  assert.deepEqual(target.require('quality_issues', issue.id), f.store.require('quality_issues', issue.id)); assert.equal(target.require<any>('quality_issues', issue.id).note, resolved.note); assert.equal(target.all('quality_scans').length, 1); assert.equal(target.database.records('quality_fingerprints').length, 0);
  importData(target, snapshot); assert.equal(target.all('quality_issues').length, 1); assert.equal(target.require<Question>('questions', 'Q1').status, 'published');
});
