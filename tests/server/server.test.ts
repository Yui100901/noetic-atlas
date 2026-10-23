import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../server/index.js';
import type { Question, SeedData } from '../../shared/models/types.js';
import { planScoredQuestions } from '../../server/modules/practice/scoring.js';

const stamp = '2026-10-20T00:00:00.000Z';
async function removeFixtureDirectory(dir: string) {
  const path = resolve(dir);
  assert.equal(dirname(path), resolve(tmpdir()), '仅允许删除系统临时目录中的测试目录');
  assert.ok(['learning-test-', 'learning-static-'].some(prefix => basename(path).startsWith(prefix)), '测试目录前缀必须匹配');
  await rm(path, { recursive: true, force: true });
}
function question(id: string, type: Question['type'], categoryIds = ['backend'], tagIds = ['go']): Question {
  return { id, title: `测试 ${id}`, type, stemMarkdown: `题干 ${id}：请选择或说明`, answerMarkdown: `参考答案 ${id}`, explanationMarkdown: `解析 ${id}：说明正确性和边界`, options: ['single_choice', 'multiple_choice'].includes(type) ? ['A', 'B', 'C'].map(key => ({ key, text: `${key}选项` })) : [], correctAnswers: type === 'true_false' ? ['true'] : type === 'single_choice' ? ['B'] : type === 'multiple_choice' ? ['A', 'C'] : [], difficulty: 2, depth: 2, frequency: 3, frequencyScope: '后端岗位', frequencyBasis: '经验估计，非统计频率', collection: 'general', status: 'published', categoryIds, tagIds, sourceRefs: [{ label: '官方文档', url: 'https://example.org/docs' }], sourceDocument: null, sourceAnchor: null };
}
function seed(): SeedData {
  return { schemaVersion: 1, generatedAt: stamp,
    domains: [{ id: 'computer', name: '计算机', description: '', sortOrder: 0 }, { id: 'medicine', name: '医学', description: '', sortOrder: 1 }],
    categories: [{ id: 'backend', domainId: 'computer', parentId: null, name: '后端', description: '', sortOrder: 0 }, { id: 'go-category', domainId: 'computer', parentId: 'backend', name: 'Go', description: '', sortOrder: 0 }, { id: 'medical-base', domainId: 'medicine', parentId: null, name: '基础', description: '', sortOrder: 0 }],
    tags: [{ id: 'go', name: 'Go', color: '#123456', description: '' }, { id: 'network', name: '网络', color: '#654321', description: '' }],
    questions: [question('Q-1', 'short_answer'), question('Q-2', 'true_false', ['go-category'], ['go', 'network']), question('Q-3', 'single_choice', ['go-category']), question('Q-4', 'multiple_choice', ['backend'], ['network']), question('Q-5', 'short_answer', ['medical-base'], [])],
    documents: [{ id: 'DOC-1', title: '复习方法', kind: '计划', bodyMarkdown: '[题目](#/questions/Q-1)', collection: 'general', categoryIds: ['backend'], tagIds: [], sourcePath: null }],
    papers: [{ id: 'P-1', title: '后端基础', description: '测试', questionIds: ['Q-1', 'Q-2', 'Q-3', 'Q-4'], mode: 'manual', filters: null }],
  };
}
async function fixture(t: test.TestContext, data = seed()) {
  const dir = await mkdtemp(join(tmpdir(), 'learning-test-'));
  const seedPath = join(dir, 'seed.json'); await writeFile(seedPath, JSON.stringify(data));
  const app = await buildApp({ databasePath: join(dir, 'test.sqlite'), seedPath, staticRoot: join(dir, 'no-static') });
  t.after(async () => { await app.close(); await removeFixtureDirectory(dir); });
  return { app, dir, seedPath };
}
function json(response: { statusCode: number; json: () => any }, status = 200) { assert.equal(response.statusCode, status, JSON.stringify(response.json())); return response.json(); }
async function addApproved(app: Awaited<ReturnType<typeof buildApp>>, q: Question) {
  const added = json(await app.inject({ method: 'POST', url: '/api/questions', payload: q }), 201);
  json(await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ids: [added.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [added.id]: added.updatedAt } } }));
  return json(await app.inject(`/api/questions/${added.id}`));
}

test('seed is persistent; filters include descendants, tag all/any and future domains', async t => {
  const { app } = await fixture(t);
  const boot = json(await app.inject('/api/bootstrap')); assert.equal(boot.stats.totalQuestions, 5);
  assert.equal(json(await app.inject('/api/questions?categoryId=backend')).total, 4);
  assert.equal(json(await app.inject('/api/questions?categoryId=go-category')).total, 2);
  assert.equal(json(await app.inject('/api/questions?tagIds=go,network&tagMode=all')).total, 1);
  assert.equal(json(await app.inject('/api/questions?tagIds=go,network&tagMode=any')).total, 4);
  assert.equal(json(await app.inject('/api/questions?domainId=medicine')).items[0].id, 'Q-5');
  const page = json(await app.inject('/api/questions?page=2&pageSize=2')); assert.equal(page.items.length, 2); assert.equal(page.total, 5);
  assert.equal(json(await app.inject('/api/questions?search=%27%20OR%201%3D1--')).total, 0);
  assert.equal((await app.inject('/api/questions?page=-1')).statusCode, 400);
});

test('question CRUD validates choices and references; archives via PUT and deletes unreferenced questions', async t => {
  const { app } = await fixture(t);
  const q = question('Q-new', 'single_choice');
  await addApproved(app, q);
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions', payload: q })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions', payload: { ...q, id: 'bad', correctAnswers: ['Z'] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/questions/Q-new', payload: { ...q, categoryIds: ['missing'] } })).statusCode, 400);
  json(await app.inject({ method: 'PUT', url: '/api/questions/Q-new', payload: { ...q, status: 'archived' } }));
  assert.equal(json(await app.inject('/api/questions?status=archived')).total, 1);
  json(await app.inject({ method: 'PUT', url: '/api/questions/Q-new', payload: { ...q, status: 'pending', title: '恢复后的题目' } }));
  assert.equal(json(await app.inject('/api/questions/Q-new')).title, '恢复后的题目');
  json(await app.inject({ method: 'DELETE', url: '/api/questions/Q-new' }));
  assert.equal((await app.inject('/api/questions/Q-new')).statusCode, 404);
});

test('taxonomy prevents cycles, cross-domain parents and deletion of references', async t => {
  const { app } = await fixture(t);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/domains/computer' })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/categories/backend' })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/tags/go' })).statusCode, 409);
  const child = seed().categories[1]!;
  assert.equal((await app.inject({ method: 'PUT', url: '/api/categories/go-category', payload: { ...child, parentId: 'go-category' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/categories/backend', payload: { ...seed().categories[0], parentId: 'go-category' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/categories/go-category', payload: { ...child, parentId: 'medical-base' } })).statusCode, 400);
  json(await app.inject({ method: 'POST', url: '/api/domains', payload: { id: 'music', name: '音乐' } }), 201);
  json(await app.inject({ method: 'POST', url: '/api/categories', payload: { id: 'music-base', name: '乐理', domainId: 'music' } }), 201);
  const q = { ...question('MUSIC-1', 'short_answer'), categoryIds: ['music-base'], tagIds: [] };
  await addApproved(app, q);
  assert.equal(json(await app.inject('/api/questions?domainId=music')).total, 1);
});

test('random papers preserve conditions, sample without duplicates and reject shortages', async t => {
  const { app } = await fixture(t);
  const payload = { title: '随机卷', mode: 'random', count: 1, filters: { tagIds: ['go', 'network'], tagMode: 'all' } };
  const all = json(await app.inject({ method: 'POST', url: '/api/papers', payload }), 201); assert.deepEqual(all.questionIds, ['Q-2']);
  const any = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { ...payload, count: 4, filters: { ...payload.filters, tagMode: 'any' } } }), 201); assert.equal(new Set(any.questionIds).size, 4);
  const shortage = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { ...payload, count: 2 } }), 422); assert.equal(shortage.error.details.available, 1);
  assert.ok(all.questions.every((q: any) => !('correctAnswers' in q) && !('answerMarkdown' in q)));
});

test('attempts hide solutions, grade on server, preserve drafts and count wrong answers once', async t => {
  const { app } = await fixture(t);
  const a = json(await app.inject({ method: 'POST', url: '/api/papers/P-1/attempts' }), 201);
  for (const q of a.questions) for (const field of ['answerMarkdown', 'explanationMarkdown', 'correctAnswers', 'sourceRefs', 'snapshot']) assert.equal(field in q, false);
  const answers = { 'Q-1': { value: '我的论述' }, 'Q-2': { value: 'false' }, 'Q-3': { value: 'B' }, 'Q-4': { value: ['C', 'A'] } };
  const draft = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}`, payload: { answers } })); assert.equal(draft.answers['Q-1'].value, '我的论述');
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}`, payload: { answers: { 'Q-1': { value: '', selfScore: 3 } } } })).statusCode, 400);
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: {} })); assert.equal(submitted.objectiveScore, 3); assert.equal(submitted.objectiveMax, 4); assert.equal(submitted.questions[1].correctAnswers[0], 'true');
  assert.equal(json(await app.inject('/api/questions/Q-2')).study.wrongCount, 1);
  json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: {} })); assert.equal(json(await app.inject('/api/questions/Q-2')).study.wrongCount, 1);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}`, payload: { answers } })).statusCode, 409);
  const reviewed = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 2 } } })); assert.equal(reviewed.subjectiveScore, 2);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-3': 3 } } })).statusCode, 400);
});

test('old paper and attempt snapshots survive editing, archiving and later paper versions', async t => {
  const { app } = await fixture(t);
  const a = json(await app.inject({ method: 'POST', url: '/api/papers/P-1/attempts' }), 201);
  const edited = { ...question('Q-3', 'single_choice'), title: '新版题', correctAnswers: ['A'], answerMarkdown: '新版答案' };
  json(await app.inject({ method: 'PUT', url: '/api/questions/Q-3', payload: edited }));
  json(await app.inject({ method: 'PUT', url: '/api/questions/Q-3', payload: { ...edited, status: 'archived' } }));
  const paper = json(await app.inject('/api/papers/P-1')); assert.notEqual(paper.questions[2].title, '新版题');
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-3': { value: 'B' } } } })); assert.equal(submitted.objectiveScore, 1); assert.deepEqual(submitted.questions[2].correctAnswers, ['B']);
  const updated = json(await app.inject({ method: 'PUT', url: '/api/papers/P-1', payload: { title: '第二版', mode: 'manual', questionIds: ['Q-1'] } })); assert.equal(updated.version, 2);
  const history = json(await app.inject(`/api/attempts/${a.id}`)); assert.equal(history.paperVersion, 1); assert.equal(history.questions.length, 4);
  json(await app.inject({ method: 'DELETE', url: '/api/papers/P-1' }));
  assert.equal((await app.inject({ method: 'POST', url: '/api/papers/P-1/attempts' })).statusCode, 409);
  assert.equal(json(await app.inject(`/api/attempts/${a.id}`)).questions.length, 4);
});

test('paper exports default to question-only content and explicitly opt into solutions', async t => {
  const { app } = await fixture(t);
  const plain = await app.inject('/api/papers/P-1/export'); assert.equal(plain.statusCode, 200); assert.equal(plain.body.includes('参考答案 Q-'), false); assert.ok(plain.body.includes('#/questions/Q-1'));
  const solved = await app.inject('/api/papers/P-1/export?answers=true'); assert.ok(solved.body.includes('参考答案 Q-1')); assert.ok(solved.body.includes('解析 Q-4'));
});

test('study notes, favorites, review intervals and documents persist as separate resources', async t => {
  const { app } = await fixture(t);
  json(await app.inject({ method: 'PUT', url: '/api/study/Q-1', payload: { favorite: true, notes: '边界待巩固', nextReviewAt: stamp } }));
  assert.equal(json(await app.inject('/api/questions?favorite=true')).total, 1); assert.equal(json(await app.inject('/api/questions?due=true')).total, 1);
  const state = json(await app.inject({ method: 'POST', url: '/api/study/Q-1/review', payload: { mastery: 3 } })); assert.equal(state.mastery, 3); assert.ok(Date.parse(state.nextReviewAt) > Date.now() + 20 * 86400000);
  assert.equal(json(await app.inject('/api/study')).reviews.length, 1);
  const doc = json(await app.inject({ method: 'POST', url: '/api/documents', payload: { title: '学习笔记', kind: '笔记', bodyMarkdown: '<script>text only</script>', collection: 'personal', categoryIds: [], tagIds: [] } }), 201);
  assert.equal(json(await app.inject(`/api/documents/${doc.id}`)).bodyMarkdown, '<script>text only</script>');
  json(await app.inject({ method: 'DELETE', url: `/api/documents/${doc.id}` })); assert.equal(json(await app.inject('/api/documents?collection=personal')).length, 0);
});

test('non-interview frequency 0 is preserved and filtered precisely without losing other questions', async t => {
  const { app } = await fixture(t);
  const q = { ...question('HOBBY-1', 'short_answer', ['medical-base'], []), frequency: 0, frequencyScope: '', frequencyBasis: '非面试内容，未设置常见度' };
  await addApproved(app, q);
  const unmarked = json(await app.inject('/api/questions?frequency=0')); assert.equal(unmarked.total, 1); assert.equal(unmarked.items[0].id, q.id);
  assert.equal(json(await app.inject('/api/questions?frequency=3')).total, 5);
  const paper = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { mode: 'random', title: '其他领域', filters: { domainId: 'medicine', frequencyMin: 0 }, count: 2 } }), 201); assert.equal(paper.questionCount, 2);
});

test('SQLite restart does not overwrite edits or reimport an archived question from seed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-test-')); const databasePath = join(dir, 'restart.sqlite'); const seedPath = join(dir, 'seed.json'); await writeFile(seedPath, JSON.stringify(seed()));
  let app = await buildApp({ databasePath, seedPath, staticRoot: join(dir, 'none') });
  try {
    json(await app.inject({ method: 'PUT', url: '/api/questions/Q-1', payload: { ...question('Q-1', 'short_answer'), title: '重启保留的编辑' } }));
    json(await app.inject({ method: 'PUT', url: '/api/questions/Q-2', payload: { ...question('Q-2', 'true_false', ['go-category'], ['go', 'network']), status: 'archived' } })); await app.close();
    app = await buildApp({ databasePath, seedPath, staticRoot: join(dir, 'none') });
    assert.equal(json(await app.inject('/api/questions/Q-1')).title, '重启保留的编辑'); assert.equal(json(await app.inject('/api/questions/Q-2')).status, 'archived');
  } finally { await app.close(); await removeFixtureDirectory(dir); }
});

test('merge imports preserve edits and roll back all tables on invalid category graphs', async t => {
  const { app } = await fixture(t);
  json(await app.inject({ method: 'PUT', url: '/api/questions/Q-1', payload: { ...question('Q-1', 'short_answer'), title: '用户编辑' } }));
  const merged = json(await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: seed() } })); assert.equal(merged.counts.questions.skipped, 5); assert.equal(json(await app.inject('/api/questions/Q-1')).title, '用户编辑');
  const broken = seed(); broken.domains.push({ id: 'rollback-domain', name: '不应保留', description: '', sortOrder: 0 }); broken.categories.push({ id: 'cycle', name: '环', domainId: 'rollback-domain', parentId: 'cycle', description: '', sortOrder: 0 });
  assert.equal((await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: broken } })).statusCode, 400);
  assert.ok(!json(await app.inject('/api/taxonomy')).domains.some((d: any) => d.id === 'rollback-domain'));
  const invalid = seed(); invalid.questions.push({ ...question('INVALID', 'short_answer'), categoryIds: ['missing'] });
  assert.equal((await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: invalid } })).statusCode, 400);
  assert.equal((await app.inject('/api/questions/INVALID')).statusCode, 404);
});

test('JSON full backups restore attempts and SQLite online backups are independent readable files', async t => {
  const { app, dir } = await fixture(t);
  const attempt = json(await app.inject({ method: 'POST', url: '/api/papers/P-1/attempts' }), 201);
  json(await app.inject({ method: 'POST', url: `/api/attempts/${attempt.id}/submit`, payload: { answers: { 'Q-2': { value: 'true' } } } }));
  json(await app.inject({ method: 'PUT', url: `/api/attempts/${attempt.id}/review`, payload: { scores: { 'Q-1': 2 } } }));
  json(await app.inject({ method: 'DELETE', url: '/api/documents/DOC-1' }));
  const exported = json(await app.inject('/api/export'));
  const empty = { ...seed(), domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] };
  const restored = await fixture(t, empty);
  const result = json(await restored.app.inject({ method: 'POST', url: '/api/import', payload: { data: exported, mode: 'merge' } })); assert.equal(result.counts.attempts.added, 1);
  const history = json(await restored.app.inject(`/api/attempts/${attempt.id}`)); assert.equal(history.status, 'submitted'); assert.equal(history.subjectiveScore, 2); assert.equal(json(await restored.app.inject('/api/study')).reviews.length, 1);
  assert.equal(json(await restored.app.inject('/api/documents')).length, 0, '归档的资料在恢复后仍须保持归档');
  const backup = await app.inject('/api/backup.sqlite'); assert.equal(backup.statusCode, 200); const copy = join(dir, 'downloaded.sqlite'); await writeFile(copy, backup.rawPayload);
  const db = new DatabaseSync(copy); try { assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok'); assert.equal((db.prepare('SELECT COUNT(*) AS n FROM questions').get() as any).n, 5); } finally { db.close(); }
});

test('JSON and SQLite downloads remove retired metadata without rewriting personal source records or graded history', async t => {
  const data=seed(); data.questions[0]!.collection='personal';
  const {app,dir}=await fixture(t,data);
  const documentation=json(await app.inject('/api/openapi.json'));
  assert.equal(Object.hasOwn(documentation.components.schemas.QuestionInput.properties,'resumePriority'),false);
  assert.ok(documentation.paths['/api/questions'].get.parameters.every((parameter:any)=>parameter.name!=='priority'));
  assert.equal(JSON.stringify(documentation.components.schemas.PaperInput).includes('"priority"'),false);
  assert.equal(JSON.stringify(documentation.components.schemas.PaperDraftState).includes('"priority"'),false);
  const attempt=json(await app.inject({method:'POST',url:'/api/papers/P-1/attempts'}),201);
  json(await app.inject({method:'POST',url:`/api/attempts/${attempt.id}/submit`,payload:{answers:{'Q-2':{value:'true'}}}}));
  json(await app.inject({method:'PUT',url:`/api/attempts/${attempt.id}/review`,payload:{scores:{'Q-1':2}}}));
  const source=new DatabaseSync(join(dir,'test.sqlite'));
  try {
    source.prepare("UPDATE questions SET data=json_set(data,'$.resumePriority','P0') WHERE id='Q-1'").run();
    source.prepare("UPDATE papers SET data=json_set(data,'$.filters',json('{\"priority\":\"P1\",\"collection\":\"all\"}'),'$.snapshot[0].resumePriority','P1') WHERE id='P-1'").run();
    source.prepare("UPDATE attempts SET data=json_set(data,'$.questions[0].resumePriority','P2') WHERE id=?").run(attempt.id);
    const exported=json(await app.inject('/api/export'));
    assert.equal(Object.hasOwn(exported.questions.find((q:any)=>q.id==='Q-1'),'resumePriority'),false);
    assert.equal(Object.hasOwn(exported.papers[0].filters,'priority'),false);
    assert.equal(Object.hasOwn(exported.papers[0].snapshot[0],'resumePriority'),false);
    assert.equal(Object.hasOwn(exported.attempts[0].questions[0],'resumePriority'),false);
    const response=await app.inject('/api/backup.sqlite');assert.equal(response.statusCode,200);
    const path=join(dir,'metadata-cleaned.sqlite');await writeFile(path,response.rawPayload);
    const copy=new DatabaseSync(path);
    try {
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok');
      const q=JSON.parse((copy.prepare("SELECT data FROM questions WHERE id='Q-1'").get() as {data:string}).data);
      const p=JSON.parse((copy.prepare("SELECT data FROM papers WHERE id='P-1'").get() as {data:string}).data);
      const a=JSON.parse((copy.prepare('SELECT data FROM attempts WHERE id=?').get(attempt.id) as {data:string}).data);
      assert.equal(q.collection,'personal');assert.equal(q.answerMarkdown,'参考答案 Q-1');
      assert.equal(Object.hasOwn(q,'resumePriority'),false);
      assert.equal(Object.hasOwn(p.filters,'priority'),false);assert.equal(p.filters.collection,'all');
      assert.equal(Object.hasOwn(p.snapshot[0],'resumePriority'),false);
      assert.equal(Object.hasOwn(a.questions[0],'resumePriority'),false);
      assert.equal(a.status,'submitted');assert.equal(a.subjectiveScore,2);assert.equal(a.answers['Q-2'].value,'true');
    } finally {copy.close();}
    assert.equal((source.prepare("SELECT json_extract(data,'$.resumePriority') AS old FROM questions WHERE id='Q-1'").get() as any).old,'P0','download cleanup must only modify the temporary backup copy');
    const restored=await fixture(t,{...seed(),domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]});
    json(await restored.app.inject({method:'POST',url:'/api/import',payload:{data:exported,mode:'merge'}}));
    assert.equal(json(await restored.app.inject('/api/questions/Q-1')).collection,'personal');
    const history=json(await restored.app.inject(`/api/attempts/${attempt.id}`));
    assert.equal(history.subjectiveScore,2);assert.equal(history.answers['Q-2'].value,'true');
  } finally {source.close();}
});

test('import rejects inconsistent attempt scores and rolls back newly inserted questions', async t => {
  const { app } = await fixture(t);
  const a = json(await app.inject({ method: 'POST', url: '/api/papers/P-1/attempts' }), 201);
  json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-2': { value: 'true' } } } }));
  const backup = json(await app.inject('/api/export')); backup.questions.push(question('ROLLBACK-1', 'short_answer')); backup.attempts[0].id = 'CORRUPT-ATTEMPT'; backup.attempts[0].objectiveScore = 999;
  assert.equal((await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: backup } })).statusCode, 400);
  assert.equal((await app.inject('/api/questions/ROLLBACK-1')).statusCode, 404);
  assert.equal((await app.inject('/api/attempts/CORRUPT-ATTEMPT')).statusCode, 404);
});

test('cross-origin writes are rejected; local Origin and AI unconfigured contract are explicit', async t => {
  const { app } = await fixture(t);
  const payload = { notes: 'test' };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/study/Q-1', headers: { host: 'localhost:4317', origin: 'https://evil.example' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/study/Q-1', headers: { host: 'localhost:4317', origin: 'http://localhost:4317' }, payload })).statusCode, 200);
  assert.equal(json(await app.inject('/api/ai/capabilities')).available, false);
  assert.equal(json(await app.inject({ method: 'POST', url: '/api/ai/paper-plan', payload: { prompt: '后端基础', count: 2 } }), 409).error.code, 'AI_DISABLED');
});

test('static serving is confined to the configured web build and does not expose data or workspace files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-static-')); const web = join(dir, 'web'); await mkdir(web); await writeFile(join(web, 'index.html'), '<!doctype html><p>学习站</p>'); await writeFile(join(dir, 'private.md'), 'PRIVATE');
  const app = await buildApp({ databasePath: join(dir, 'db.sqlite'), seedPath: join(dir, 'none.json'), staticRoot: web });
  t.after(async () => { await app.close(); await removeFixtureDirectory(dir); });
  assert.ok((await app.inject('/')).body.includes('学习站')); assert.equal((await app.inject('/private.md')).statusCode, 404); assert.equal((await app.inject('/data/db.sqlite')).statusCode, 404); assert.equal((await app.inject('/api/missing')).statusCode, 404);
  assert.ok(!(await app.inject('/../private.md')).body.includes('PRIVATE'));
});

test('manual scoring checks decimal totals and snapshots real point values without leaking answers', async t => {
  const { app } = await fixture(t);
  const input = { title: '手工小数计分', mode: 'manual', questionIds: ['Q-1', 'Q-2', 'Q-3', 'Q-4'], scoring: { enabled: true, totalPoints: 11, questionPoints: { 'Q-1': 5.5, 'Q-2': 1.25, 'Q-3': 2.25, 'Q-4': 2 } } };
  const paper = json(await app.inject({ method: 'POST', url: '/api/papers', payload: input }), 201);
  assert.equal(paper.scoring.scheme, 'custom'); assert.equal(paper.scoring.totalPoints, 11); assert.equal(paper.scoring.objectivePoints, 5.5); assert.equal(paper.questions[2].points, 2.25);
  assert.equal((await app.inject({ method: 'POST', url: '/api/papers', payload: { ...input, scoring: { ...input.scoring, totalPoints: 10.99 } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/papers', payload: { ...input, scoring: { ...input.scoring, questionPoints: { 'Q-1': 5.5 } } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/papers', payload: { ...input, scoring: { enabled: true, pointsByType: { short_answer: 0.001 } } } })).statusCode, 400);
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${paper.id}/attempts` }), 201);
  assert.equal(a.questions[0].points, 5.5); assert.equal(a.totalScore, null); assert.ok(!('correctAnswers' in a.questions[1]));
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-2': { value: 'true' }, 'Q-3': { value: 'B' }, 'Q-4': { value: ['A', 'C'] } } } }));
  assert.equal(submitted.objectiveScore, 5.5); assert.equal(submitted.pendingSubjectiveCount, 1); assert.equal(submitted.totalScore, null);
  const zero = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 0 } } }));
  assert.equal(zero.gradedSubjectiveCount, 1); assert.equal(zero.pendingSubjectiveCount, 0); assert.equal(zero.gradingStatus, 'complete'); assert.equal(zero.totalScore, 5.5);
  const corrected = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 3.25 }, mastery: { 'Q-1': 1, 'Q-3': 3 } } }));
  assert.equal(corrected.totalScore, 8.75); assert.equal(corrected.answers['Q-1'].mastery, 1); assert.equal(corrected.answers['Q-3'].mastery, 3); assert.equal(json(await app.inject('/api/questions/Q-1')).study.mastery, 1);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 5.51 } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-3': 1 } } })).statusCode, 400);
  const ungraded = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': null } } })); assert.equal(ungraded.totalScore, null); assert.equal(ungraded.pendingSubjectiveCount, 1); assert.equal(ungraded.subjectiveScore, 0);
  const exported = await app.inject(`/api/papers/${paper.id}/export`); assert.ok(exported.body.includes('总分 11 分')); assert.ok(exported.body.includes('2.25 分')); assert.ok(!exported.body.includes('参考答案 Q-1'));
});

test('unscored papers still accept answers, mistakes and independent mastery without numeric grades', async t => {
  const { app } = await fixture(t);
  const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '只学习不计分', mode: 'manual', questionIds: ['Q-1', 'Q-2'], scoring: { enabled: false } } }), 201);
  assert.equal(p.scoring.scheme, 'none'); assert.equal(p.scoring.totalPoints, 0); assert.deepEqual(p.questions.map((q: any) => q.points), [0, 0]);
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201);
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-2': { value: 'false' } } } }));
  assert.equal(submitted.objectiveMax, 0); assert.equal(submitted.objectiveScore, 0); assert.equal(submitted.totalScore, null); assert.equal(submitted.gradingStatus, 'not_applicable'); assert.equal(json(await app.inject('/api/questions/Q-2')).study.wrongCount, 1);
  const reviewed = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { mastery: { 'Q-1': 2, 'Q-2': 3 } } })); assert.equal(reviewed.answers['Q-2'].mastery, 3); assert.equal(reviewed.subjectiveMax, 0);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 0 } } })).statusCode, 400);
});

test('scored random planning builds exact default 100-point papers, derives counts and keeps previews ephemeral', async t => {
  const data = seed();
  for (const type of ['short_answer', 'true_false', 'single_choice', 'multiple_choice'] as const) for (let i = 0; i < 45; i++) data.questions.push(question(`POOL-${type}-${i}`, type));
  const { app } = await fixture(t, data);
  const input = { title: '百分卷', mode: 'random', filters: { tagIds: ['go'], tagMode: 'all' }, scoring: { enabled: true, totalPoints: 100, objectivePercent: 60 } };
  const preview = json(await app.inject({ method: 'POST', url: '/api/papers/preview', payload: input }));
  assert.equal(preview.scoring.totalPoints, 100); assert.equal(preview.scoring.actualObjectivePercent, 61); assert.equal(preview.scoring.subjectivePoints, 39); assert.equal(new Set(preview.questionIds).size, preview.questionCount); assert.equal(json(await app.inject('/api/papers')).length, 1);
  assert.equal(preview.questions.reduce((sum: number, q: any) => sum + q.points, 0), 100);
  const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { ...input, count: 50 } }), 201); assert.equal(p.questionCount, 50); assert.equal(p.scoring.totalPoints, 100);
  const impossible = json(await app.inject({ method: 'POST', url: '/api/papers/preview', payload: { ...input, count: 5 } }), 422); assert.equal(impossible.error.code, 'UNREACHABLE_TOTAL_POINTS');
  const subjectiveOnly = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { ...input, filters: { types: ['short_answer'] } } }), 422); assert.equal(subjectiveOnly.error.code, 'UNREACHABLE_TOTAL_POINTS');
  const decimal = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { ...input, scoring: { enabled: true, totalPoints: 2.5, objectivePercent: 60, pointsByType: { true_false: 0.25, single_choice: 0.25, multiple_choice: 0.25, short_answer: 0.75 } } } }), 201); assert.equal(decimal.scoring.totalPoints, 2.5); assert.equal(decimal.scoring.actualObjectivePercent, 70);
});

test('bounded planner agrees with independent exhaustive combinations for small pools and exact totals', () => {
  const names = ['true_false', 'single_choice', 'multiple_choice', 'short_answer'] as const;
  const pool = names.flatMap(type => Array.from({ length: 3 }, (_, i) => question(`${type}-${i}`, type)));
  const points = { true_false: 0.25, single_choice: 0.5, multiple_choice: 0.75, short_answer: 1.25 };
  for (let target = 1; target <= 33; target++) {
    const possible: number[] = [];
    for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) for (let c = 0; c <= 3; c++) for (let d = 0; d <= 3; d++) if (a + 2 * b + 3 * c + 5 * d === target) possible.push(Math.abs((a + 2 * b + 3 * c) / target * 100 - 60));
    if (!possible.length) assert.throws(() => planScoredQuestions(pool, { enabled: true, totalPoints: target / 4, pointsByType: points }));
    else {
      const plan = planScoredQuestions(pool, { enabled: true, totalPoints: target / 4, pointsByType: points }); const n = plan.selected;
      assert.equal(n.true_false + 2 * n.single_choice + 3 * n.multiple_choice + 5 * n.short_answer, target);
      assert.ok(Math.abs(Math.abs((target - 5 * n.short_answer) / target * 100 - 60) - Math.min(...possible)) < 1e-8);
    }
  }
});

test('scoring snapshots survive reconfiguration and JSON restore, while corrupted score maps roll back', async t => {
  const { app } = await fixture(t);
  const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '快照计分', mode: 'manual', questionIds: ['Q-1', 'Q-2'], scoring: { enabled: true, totalPoints: 6, questionPoints: { 'Q-1': 4.5, 'Q-2': 1.5 } } } }), 201);
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201);
  json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-2': { value: 'true' } } } }));
  json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 3.75 } } }));
  json(await app.inject({ method: 'PUT', url: `/api/papers/${p.id}`, payload: { title: '新版不计分', mode: 'manual', questionIds: ['Q-1', 'Q-2'], scoring: { enabled: false } } }));
  assert.equal(json(await app.inject(`/api/attempts/${a.id}`)).totalScore, 5.25);
  const exported = json(await app.inject('/api/export')); const empty = { ...seed(), domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] }; const restored = await fixture(t, empty);
  json(await restored.app.inject({ method: 'POST', url: '/api/import', payload: { data: exported, mode: 'merge' } }));
  assert.equal(json(await restored.app.inject(`/api/attempts/${a.id}`)).totalScore, 5.25); assert.equal(json(await restored.app.inject(`/api/papers/${p.id}`)).scoring.enabled, false);
  const corrupt = structuredClone(exported); const paper = corrupt.papers.find((x: any) => x.id === p.id); paper.id = 'CORRUPT-PAPER'; paper.scoring.totalPoints = 100;
  assert.equal((await restored.app.inject({ method: 'POST', url: '/api/import', payload: { data: corrupt, mode: 'merge' } })).statusCode, 400); assert.equal((await restored.app.inject('/api/papers/CORRUPT-PAPER')).statusCode, 404);
});

test('legacy backups retain fixed scores and AI grading stays unconfigured without changing grades', async t => {
  const { app } = await fixture(t);
  assert.equal(json(await app.inject('/api/papers/P-1')).scoring.scheme, 'legacy');
  const a = json(await app.inject({ method: 'POST', url: '/api/papers/P-1/attempts' }), 201);
  assert.equal((await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/ai-review` })).statusCode, 409);
  json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-3': { value: 'B' } } } }));
  json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 2 } } }));
  const exported = json(await app.inject('/api/export')); for (const paper of exported.papers) delete paper.scoring; for (const attempt of exported.attempts) delete attempt.scoring;
  const empty = { ...seed(), domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] }; const restored = await fixture(t, empty);
  json(await restored.app.inject({ method: 'POST', url: '/api/import', payload: { data: exported, mode: 'merge' } })); const history = json(await restored.app.inject(`/api/attempts/${a.id}`)); assert.equal(history.objectiveScore, 1); assert.equal(history.subjectiveScore, 2); assert.equal(history.scoring.scheme, 'legacy');
  const ai = json(await restored.app.inject({ method: 'POST', url: `/api/attempts/${a.id}/ai-review` }), 501); assert.equal(ai.error.code, 'AI_GRADING_NOT_CONFIGURED'); assert.equal(json(await restored.app.inject(`/api/attempts/${a.id}`)).totalScore, 3); assert.equal(json(await restored.app.inject('/api/ai/capabilities')).subjectiveReview.available, false);
});

test('random scoring respects single-type filters and explains the resulting ratio rather than inventing missing question types', async t => {
  const { app } = await fixture(t);
  for (const [type, totalPoints, expectedCount, expectedPercent] of [
    ['single_choice', 2, 1, 100], ['multiple_choice', 2, 1, 100], ['true_false', 1, 1, 100], ['short_answer', 6, 2, 0],
  ] as const) {
    const paper = json(await app.inject({ method: 'POST', url: '/api/papers/preview', payload: { title: `只含${type}`, mode: 'random', filters: { types: [type] }, scoring: { enabled: true, totalPoints } } }));
    assert.equal(paper.questionCount, expectedCount); assert.equal(paper.scoring.objectivePercent, 60); assert.equal(paper.scoring.actualObjectivePercent, expectedPercent); assert.ok(paper.questions.every((q: any) => q.type === type));
  }
  const noScore = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '随机无分', mode: 'random', count: 2, filters: { types: ['short_answer'] }, scoring: { enabled: false } } }), 201);
  assert.equal(noScore.scoring.totalPoints, 0); assert.equal(noScore.questionCount, 2);
  const defaultCount = await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '默认题量20但池不足', mode: 'random', scoring: { enabled: false } } });
  assert.equal(defaultCount.statusCode, 422); assert.equal(defaultCount.json().error.details.requested, 20);
  assert.equal((await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '默认总分100但池不足', mode: 'random', count: 2, scoring: { enabled: true } } })).statusCode, 422);
});

test('partial subjective grading, explicit zero, retraction and rollback preserve objective grades and independent mastery', async t => {
  const { app } = await fixture(t);
  const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '分步阅卷', mode: 'manual', questionIds: ['Q-1', 'Q-5', 'Q-2'], scoring: { enabled: true, questionPoints: { 'Q-1': 0.5, 'Q-5': 9.5, 'Q-2': 2 } } } }), 201);
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201);
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-2': { value: 'true' } } } }));
  assert.equal(submitted.objectiveScore, 2); assert.equal(submitted.totalScore, null); assert.equal(submitted.pendingSubjectiveCount, 2);
  const partial = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 0 }, mastery: { 'Q-1': 3 } } }));
  assert.equal(partial.gradingStatus, 'partial'); assert.equal(partial.gradedSubjectiveCount, 1); assert.equal(partial.totalScore, null); assert.equal(partial.answers['Q-1'].mastery, 3);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-5': 8, 'Q-2': 1 }, mastery: { 'Q-1': 0 } } })).statusCode, 400);
  const rollback = json(await app.inject(`/api/attempts/${a.id}`)); assert.equal(rollback.subjectiveScore, 0); assert.equal(rollback.answers['Q-5'], undefined); assert.equal(json(await app.inject('/api/questions/Q-1')).study.mastery, 3);
  const done = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-5': 9.25 } } }));
  assert.equal(done.gradingStatus, 'complete'); assert.equal(done.totalScore, 11.25); assert.equal(done.pendingSubjectiveCount, 0);
  const ungraded = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': null } } }));
  assert.equal(ungraded.gradingStatus, 'partial'); assert.equal(ungraded.totalScore, null); assert.equal(ungraded.objectiveScore, 2); assert.equal(ungraded.subjectiveScore, 9.25); assert.equal(ungraded.answers['Q-1'].mastery, 3);
  const exported = await app.inject(`/api/papers/${p.id}/export`); assert.ok(exported.body.includes('总分 12 分')); assert.ok(exported.body.includes('0.5 分')); assert.ok(!exported.body.includes('参考答案 Q-1'));
});

test('imports reject corrupted score snapshots atomically and ignore client-invented calculated grade displays', async t => {
  const { app } = await fixture(t);
  const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '严格导入', mode: 'manual', questionIds: ['Q-1', 'Q-2'], scoring: { enabled: true, questionPoints: { 'Q-1': 4, 'Q-2': 2 } } } }), 201);
  const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201);
  json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-2': { value: 'true' } } } }));
  const exported = json(await app.inject('/api/export'));
  const mutations = [
    (data: any) => { data.papers.find((x: any) => x.id === 'CORRUPT-SCORING').scoring.questionPoints['Q-1'] = 0; },
    (data: any) => { delete data.papers.find((x: any) => x.id === 'CORRUPT-SCORING').scoring.pointsByType.multiple_choice; },
    (data: any) => { data.papers.find((x: any) => x.id === 'CORRUPT-SCORING').scoring.objectivePoints = 3; },
    (data: any) => { data.attempts[0].scoring.questionPoints['Q-1'] = 9; },
    (data: any) => { data.attempts[0].objectiveScore = 1; },
  ];
  for (const mutate of mutations) {
    const corrupt = structuredClone(exported); corrupt.papers.find((x: any) => x.id === p.id).id = 'CORRUPT-SCORING'; corrupt.questions.push(question('ROLLBACK-SCORING', 'short_answer')); mutate(corrupt);
    assert.equal((await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: corrupt } })).statusCode, 400);
    assert.equal((await app.inject('/api/questions/ROLLBACK-SCORING')).statusCode, 404); assert.equal((await app.inject('/api/papers/CORRUPT-SCORING')).statusCode, 404);
  }
  const empty = { ...seed(), domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] }; const restored = await fixture(t, empty);
  exported.attempts[0].totalScore = 999; exported.attempts[0].pendingSubjectiveCount = 0; exported.attempts[0].gradingStatus = 'complete';
  json(await restored.app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: exported } }));
  const actual = json(await restored.app.inject(`/api/attempts/${a.id}`)); assert.equal(actual.totalScore, null); assert.equal(actual.pendingSubjectiveCount, 1); assert.equal(actual.objectiveScore, 2);
});

test('SQLite restart preserves exact custom scores, unfinished grading and unscored papers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-test-')); const databasePath = join(dir, 'scoring-restart.sqlite'); const seedPath = join(dir, 'seed.json'); await writeFile(seedPath, JSON.stringify(seed()));
  let app = await buildApp({ databasePath, seedPath, staticRoot: join(dir, 'none') });
  try {
    const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '重启分值', mode: 'manual', questionIds: ['Q-1', 'Q-2'], scoring: { enabled: true, totalPoints: 2.75, questionPoints: { 'Q-1': 2.5, 'Q-2': 0.25 } } } }), 201);
    const noScore = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '重启无分', mode: 'manual', questionIds: ['Q-1'], scoring: { enabled: false } } }), 201);
    const a = json(await app.inject({ method: 'POST', url: `/api/papers/${p.id}/attempts` }), 201);
    json(await app.inject({ method: 'POST', url: `/api/attempts/${a.id}/submit`, payload: { answers: { 'Q-2': { value: 'true' } } } })); await app.close();
    app = await buildApp({ databasePath, seedPath, staticRoot: join(dir, 'none') });
    const pending = json(await app.inject(`/api/attempts/${a.id}`)); assert.equal(pending.objectiveScore, 0.25); assert.equal(pending.subjectiveMax, 2.5); assert.equal(pending.totalScore, null); assert.equal(pending.pendingSubjectiveCount, 1);
    assert.equal(json(await app.inject(`/api/papers/${noScore.id}`)).scoring.enabled, false);
    const complete = json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { scores: { 'Q-1': 2.25 } } })); assert.equal(complete.totalScore, 2.5);
    await app.close(); app = await buildApp({ databasePath, seedPath, staticRoot: join(dir, 'none') });
    assert.equal(json(await app.inject(`/api/attempts/${a.id}`)).totalScore, 2.5);
  } finally { await app.close(); await removeFixtureDirectory(dir); }
});

test('new questions require explicit user review; pending and drafts stay outside formal counts and paper pools', async t => {
  const { app } = await fixture(t);
  const q = json(await app.inject({ method: 'POST', url: '/api/questions', payload: question('PENDING-1', 'short_answer') }), 201);
  assert.equal(q.status, 'pending', 'a client cannot directly publish a newly created question');
  assert.equal(json(await app.inject('/api/bootstrap')).stats.totalQuestions, 5);
  assert.equal(json(await app.inject('/api/questions')).total, 5);
  assert.deepEqual(json(await app.inject('/api/questions?status=pending')).items.map((x: Question) => x.id), ['PENDING-1']);
  assert.equal((await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '绕过审核', mode: 'manual', questionIds: [q.id] } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/questions/${q.id}`, payload: { ...q, status: 'published' } })).statusCode, 409);
  const review = { ids: [q.id], action: 'approve', expectedUpdatedAt: { [q.id]: q.updatedAt } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/review', payload: review })).statusCode, 400);
  const approved = json(await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ...review, confirmed: true } }));
  assert.equal(approved.count, 1); assert.equal(approved.items[0].status, 'published');
  assert.ok(approved.items[0].updatedAt > q.updatedAt);
  assert.equal(json(await app.inject('/api/bootstrap')).stats.totalQuestions, 6);
  const draft = json(await app.inject({ method: 'POST', url: '/api/questions', payload: { ...question('DRAFT-1', 'short_answer'), status: 'draft' } }), 201);
  assert.equal(draft.status, 'draft');
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ids: [draft.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [draft.id]: draft.updatedAt } } })).statusCode, 409);
  const edited = json(await app.inject({ method: 'PUT', url: `/api/questions/${q.id}`, payload: { ...approved.items[0], title: '已发布题可原位修订' } }));
  assert.equal(edited.status, 'published');
  assert.equal((await app.inject({ method: 'PUT', url: `/api/questions/${q.id}`, payload: { ...approved.items[0], title: '旧版本不能覆盖' } })).statusCode, 409);
});

test('batch review rejects stale, missing or non-pending members atomically and can return questions to draft', async t => {
  const { app } = await fixture(t);
  const a = json(await app.inject({ method: 'POST', url: '/api/questions', payload: question('BATCH-A', 'short_answer') }), 201);
  const b = json(await app.inject({ method: 'POST', url: '/api/questions', payload: question('BATCH-B', 'short_answer') }), 201);
  const newer = json(await app.inject({ method: 'PUT', url: `/api/questions/${b.id}`, payload: { ...b, title: '刚刚修改' } }));
  const payload = { ids: [a.id, b.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [a.id]: a.updatedAt, [b.id]: b.updatedAt } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/review', payload })).statusCode, 409);
  assert.equal(json(await app.inject(`/api/questions/${a.id}`)).status, 'pending');
  const published = json(await app.inject('/api/questions/Q-1'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ...payload, ids: [a.id, 'Q-1'], expectedUpdatedAt: { [a.id]: a.updatedAt, 'Q-1': published.updatedAt } } })).statusCode, 409);
  assert.equal(json(await app.inject(`/api/questions/${a.id}`)).status, 'pending');
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ...payload, ids: [] } })).statusCode, 400);
  const returned = json(await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ...payload, action: 'return_to_draft', expectedUpdatedAt: { [a.id]: a.updatedAt, [b.id]: newer.updatedAt } } }));
  assert.ok(returned.items.every((q: Question) => q.status === 'draft'));
  assert.equal(json(await app.inject('/api/questions?status=pending')).total, 0);
});

test('pending JSON supports bulk editing with atomic validation, immutable states and optimistic conflict protection', async t => {
  const { app } = await fixture(t);
  const a = json(await app.inject({ method: 'POST', url: '/api/questions', payload: question('JSON-A', 'short_answer') }), 201);
  const b = json(await app.inject({ method: 'POST', url: '/api/questions', payload: question('JSON-B', 'single_choice') }), 201);
  const data = json(await app.inject({ method: 'POST', url: '/api/questions/pending/export', payload: { ids: [a.id, b.id] } }));
  assert.equal(data.format, 'learning-pending-questions'); assert.ok(!('study' in data.questions[0]));
  data.questions[0].title = '在外部 JSON 中修订'; data.questions[0].createdAt = '2020-01-01T00:00:00.000Z';
  const invalid = structuredClone(data); invalid.questions[1].categoryIds = ['no-category'];
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/pending/import', payload: { data: invalid, confirmed: true } })).statusCode, 400);
  assert.equal(json(await app.inject(`/api/questions/${a.id}`)).title, a.title);
  const updated = json(await app.inject({ method: 'POST', url: '/api/questions/pending/import', payload: { data, confirmed: true } }));
  assert.equal(updated.updated, 2); assert.equal(updated.items[0].status, 'pending'); assert.equal(updated.items[0].createdAt, a.createdAt);
  assert.equal(updated.items[0].title, '在外部 JSON 中修订');
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/pending/import', payload: { data, confirmed: true } })).statusCode, 409);
  const bypass = structuredClone(data); bypass.questions[0].status = 'published';
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/pending/import', payload: { data: bypass, confirmed: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/pending/export', payload: { ids: ['Q-1'] } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/pending/export', payload: { ids: [] } })).statusCode, 400);
  const protectedRecord = json(await app.inject('/api/questions/Q-1'));
  const publishedTarget = { ...data, questions: [{ ...protectedRecord, status: 'pending', title: '不能覆盖已发布题' }] };
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions/pending/import', payload: { data: publishedTarget, confirmed: true } })).statusCode, 409);
  assert.equal(json(await app.inject('/api/questions/Q-1')).title, protectedRecord.title);
});

test('hard deletion protects current papers but preserves independently usable attempt snapshots and full backup restoration', async t => {
  const { app } = await fixture(t);
  const attempt = json(await app.inject({ method: 'POST', url: '/api/papers/P-1/attempts' }), 201);
  json(await app.inject({ method: 'PUT', url: '/api/study/Q-1', payload: { notes: '删除时清理', favorite: true } }));
  json(await app.inject({ method: 'POST', url: '/api/study/Q-1/review', payload: { mastery: 2 } }));
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/questions/Q-1' })).statusCode, 409);
  json(await app.inject({ method: 'PUT', url: '/api/papers/P-1', payload: { title: '新版不再包含前两题', mode: 'manual', questionIds: ['Q-3', 'Q-4'] } }));
  json(await app.inject({ method: 'DELETE', url: '/api/questions/Q-1' }));
  json(await app.inject({ method: 'DELETE', url: '/api/questions/Q-2' }));
  assert.equal((await app.inject('/api/questions/Q-1')).statusCode, 404);
  const study = json(await app.inject('/api/study')); assert.ok(!study.items.some((s: any) => ['Q-1', 'Q-2'].includes(s.questionId))); assert.equal(study.reviews.length, 0);
  const submitted = json(await app.inject({ method: 'POST', url: `/api/attempts/${attempt.id}/submit`, payload: { answers: { 'Q-1': { value: '旧卷仍可回答' }, 'Q-2': { value: 'false' } } } }));
  assert.equal(submitted.questions.length, 4); assert.deepEqual(submitted.questions[1].correctAnswers, ['true']);
  const reviewed = json(await app.inject({ method: 'PUT', url: `/api/attempts/${attempt.id}/review`, payload: { scores: { 'Q-1': 2 } } })); assert.equal(reviewed.subjectiveScore, 2);
  assert.ok(!json(await app.inject('/api/study')).items.some((s: any) => ['Q-1', 'Q-2'].includes(s.questionId)), '历史作答不得复活已删题目的学习行');
  const exported = json(await app.inject('/api/export'));
  const restored = await fixture(t, { ...seed(), domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] });
  json(await restored.app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: exported } }));
  assert.equal((await restored.app.inject('/api/questions/Q-1')).statusCode, 404);
  assert.equal(json(await restored.app.inject(`/api/attempts/${attempt.id}`)).questions[0].answerMarkdown, '参考答案 Q-1');
  assert.equal(json(await restored.app.inject(`/api/attempts/${attempt.id}`)).subjectiveScore, 2);
});

test('tags infer stable legacy domain scopes, preserve global methods and enforce domain references atomically', async t => {
  const data = seed();
  data.tags.push({ id: 'cross-domain', name: '跨领域主题', color: '#111', description: '' }, { id: 'uncategorized', name: '原无分类', color: '#111', description: '' });
  data.questions[0]!.tagIds.push('cross-domain', 'uncategorized'); data.questions[4]!.tagIds.push('cross-domain');
  data.documents.push({ ...data.documents[0]!, id: 'NO-CATEGORY', categoryIds: [], tagIds: ['uncategorized'] });
  const { app } = await fixture(t, data);
  const tags = json(await app.inject('/api/taxonomy')).tags;
  assert.equal(tags.find((x: any) => x.id === 'go').domainId, 'computer');
  assert.equal(tags.find((x: any) => x.id === 'cross-domain').domainId, null);
  assert.equal(tags.find((x: any) => x.id === 'uncategorized').domainId, null, 'legacy uncategorized references require global scope');
  json(await app.inject({ method: 'POST', url: '/api/tags', payload: { id: 'concept', name: '概念', kind: 'method', domainId: null } }), 201);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tags', payload: { id: 'bad-method', name: '非法方法标签', kind: 'method', domainId: 'computer' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/questions', payload: { ...question('BAD-DOMAIN', 'short_answer', ['medical-base'], ['go']) } })).statusCode, 400);
  const general = json(await app.inject({ method: 'POST', url: '/api/questions', payload: question('GLOBAL-METHOD', 'short_answer', ['medical-base'], ['concept']) }), 201); assert.equal(general.status, 'pending');
  const goTag = tags.find((x: any) => x.id === 'go');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/tags/go', payload: { ...goTag, domainId: 'medicine' } })).statusCode, 400);
  assert.equal(json(await app.inject('/api/taxonomy')).tags.find((x: any) => x.id === 'go').domainId, 'computer');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/categories/backend', payload: { ...seed().categories[0], domainId: 'medicine' } })).statusCode, 409);
  json(await app.inject({ method: 'POST', url: '/api/domains', payload: { id: 'new-domain', name: '未来知识领域' } }), 201);
  json(await app.inject({ method: 'POST', url: '/api/tags', payload: { id: 'domain-only', name: '领域主题', kind: 'topic', domainId: 'new-domain' } }), 201);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/domains/new-domain' })).statusCode, 409);
  json(await app.inject({ method: 'DELETE', url: '/api/tags/domain-only' })); json(await app.inject({ method: 'DELETE', url: '/api/domains/new-domain' }));
});
