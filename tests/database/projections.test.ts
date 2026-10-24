import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseConnection } from '../../server/database/connection.js';
import { projectionSources } from '../../server/database/projections.js';
import { recordTables, type RecordTable } from '../../server/database/schema.js';

const date = '2024-05-06T07:08:09.000Z';
const image = (id: string) => `![测试图片](/api/assets/${encodeURIComponent(id)}/content)`;
function question(changes: Record<string, unknown> = {}) {
  return {
    id: 'question-original', title: ' ＡLPHA École 南京 ', status: 'pending', collection: 'personal', type: 'short_answer',
    difficulty: 2, depth: 3, frequency: 0, categoryIds: ['category-original'], tagIds: ['tag-original'],
    stemMarkdown: `题干原文、全角字母与emoji 📚 ${image('asset-10')}`, answerMarkdown: '答案原文保持标点与空格。',
    explanationMarkdown: '原解析不能被投影重建改写。', createdAt: date, updatedAt: date,
    ...changes,
  };
}
function seed(database: DatabaseConnection, largeBody = false) {
  const original = question(largeBody ? { stemMarkdown: `${image('asset-10')} ${'持久投影正文无需重读。'.repeat(16_000)}` } : {});
  const records: Array<[RecordTable, string, unknown]> = [
    ['questions', 'question-original', original],
    ['documents', 'document-original', { id: 'document-original', title: '归档资料', _archived: true, bodyMarkdown: image('asset-document'), assetId: 'asset-pdf', updatedAt: date }],
    ['papers', 'paper-original', { id: 'paper-original', title: '历史试卷', archived: false, mode: 'manual', questionIds: [original.id], snapshot: [original], description: '试卷说明原文', createdAt: date, updatedAt: date }],
    ['attempts', 'attempt-original', { id: 'attempt-original', paperId: 'paper-original', status: 'submitted', questions: [original], answers: { [original.id]: { value: '原始作答、空格  与换行\n保留。' } }, startedAt: date, submittedAt: date }],
    ['study', 'question-original', { questionId: original.id, favorite: true, mastery: 2, notes: `个人笔记\n${image('asset-notes')}`, nextReviewAt: date, lastReviewedAt: date, wrongCount: 3 }],
    ['reviews', 'review-original', { id: 'review-original', questionId: original.id, reviewedAt: date, mastery: 2, note: image('asset-review') }],
    ['ai_settings', 'global', { id: 'global', enabled: true, key: 'sk-test-projection-only-never-a-real-key', endpoint: 'https://example.invalid/v1', updatedAt: date }],
    ['ai_runs', 'run-original', { id: 'run-original', kind: 'explain', createdAt: date, result: { explanationMarkdown: 'AI原始解释，保留。' } }],
    ['settings', 'global', { id: 'global', maxPaperDrafts: 3, arbitraryUserNote: '设置原文保持。' }],
    ['assets', 'asset-10', { id: 'asset-10', dataBase64: '/api/assets/base64-false-positive/content', createdAt: date }],
    ['question_banks', 'bank-original', { id: 'bank-original', name: '个人集合', questionIds: [original.id], updatedAt: date }],
  ];
  // Deliberately retain whitespace in canonical JSON: projections must not
  // deserialize/reserialize authoritative entities as a side effect of rebuilding.
  for (const [table, id, record] of records) database.run(database.query.insertInto(table).values({ id, data: '\n' + JSON.stringify(record, null, 2) + '\n' }));
  return original;
}
function canonical(database: DatabaseConnection) {
  return Object.fromEntries(recordTables.map(table => [table, database.all(database.query.selectFrom(table).select(['id', 'data']).orderBy('id')).map(row => ({ ...row }))]));
}
function pending(database: DatabaseConnection) {
  return database.all(database.query.selectFrom('projection_pending').selectAll().orderBy('source_table').orderBy('source_id')).map(row => ({ ...row }));
}
function references(database: DatabaseConnection) {
  return database.all(database.query.selectFrom('asset_references').selectAll().orderBy('source_table').orderBy('source_id').orderBy('asset_id')).map(row => ({ ...row }));
}
function derived(database: DatabaseConnection) {
  return {
    questions: database.all(database.query.selectFrom('question_read_model').selectAll().orderBy('id')).map(row => ({ ...row })),
    papers: database.all(database.query.selectFrom('paper_read_model').selectAll().orderBy('id')).map(row => ({ ...row })),
    references: references(database), pending: pending(database),
  };
}
async function temporary(t: test.TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-projections-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return join(folder, 'projections.sqlite');
}

test('persisted clean projections survive reopen and warm reads do not select canonical bodies', async t => {
  const path = await temporary(t);
  let database = new DatabaseConnection(path);
  seed(database, true); database.projections.refreshAll();
  assert.deepEqual(pending(database), []);
  const expected = derived(database); database.close();
  database = new DatabaseConnection(path);
  const originalAll = database.all.bind(database), originalOne = database.one.bind(database), selected: string[] = [];
  const inspect = (value: any) => {
    const sql = 'compile' in value ? value.compile().sql : value.sql; selected.push(sql);
    assert.doesNotMatch(sql, /\bfrom\s+"?(?:questions|papers|documents|attempts|study|reviews)"?(?:\s|$)/i, 'clean projection reads must not touch canonical bodies');
  };
  database.all = ((value: any) => { inspect(value); return originalAll(value); }) as typeof database.all;
  database.one = ((value: any) => { inspect(value); return originalOne(value); }) as typeof database.one;
  try {
    database.projections.initialize(); database.projections.ensure(projectionSources); database.projections.refreshAll();
    assert.deepEqual(derived(database), expected);
    const row = database.one(database.query.selectFrom('question_read_model').selectAll().where('id', '=', 'question-original'))!;
    const metadata = JSON.parse(row.data);
    assert.equal(metadata.status, 'pending'); assert.equal(metadata.collection, 'personal');
    assert.ok(!Object.hasOwn(metadata, 'stemMarkdown')); assert.ok(!Object.hasOwn(metadata, 'answerMarkdown'));
    assert.ok(row.search_text.includes('持久投影正文无需重读。')); assert.equal(row.title_key, 'alpha école 南京');
    assert.ok(selected.some(sql => sql.includes('projection_pending')));
  } finally { database.all = originalAll; database.one = originalOne; database.close(); }
});

for (const table of ['question_read_model', 'paper_read_model', 'asset_references', 'projection_pending'] as const) {
  test(`missing ${table} is rebuilt on reopen without altering canonical JSON`, async t => {
    const path = await temporary(t); let database = new DatabaseConnection(path);
    seed(database); database.projections.refreshAll();
    const originals = canonical(database), expected = derived(database);
    database.run(database.query.schema.dropTable(table)); database.close();
    database = new DatabaseConnection(path);
    try {
      assert.ok(database.hasTable(table)); assert.ok(pending(database).length > 0);
      database.projections.refreshAll();
      assert.deepEqual(derived(database), expected); assert.deepEqual(canonical(database), originals);
    } finally { database.close(); }
  });
}

test('obsolete projection version invalidates stale derived content and rebuilds authoritative rows', () => {
  const database = new DatabaseConnection(':memory:');
  try {
    seed(database); database.projections.refreshAll(); const originals = canonical(database), expected = derived(database);
    database.run(database.query.updateTable('question_read_model').set({ data: '{"title":"stale"}', search_text: 'stale', title_key: 'stale' }));
    database.run(database.query.insertInto('asset_references').values({ source_table: 'questions', source_id: 'ghost', asset_id: 'ghost-asset' }));
    database.run(database.query.updateTable('metadata').set({ value: 'obsolete-test-version' }).where('key', '=', 'read_projection_version'));
    database.projections.initialize(); assert.ok(pending(database).length > 0); database.projections.refreshAll();
    assert.deepEqual(derived(database), expected); assert.deepEqual(canonical(database), originals);
    assert.equal(database.one(database.query.selectFrom('metadata').select('value').where('key', '=', 'read_projection_version'))?.value, '4');
  } finally { database.close(); }
});

test('compact paper snapshots retain original-root identities without retaining leaf bodies',()=>{
  const database=new DatabaseConnection(':memory:');
  try{
    database.putRecord('papers','identity-paper',{id:'identity-paper',snapshot:[question({id:'group::leaf',sourceQuestionId:'group',groupId:'group',stemMarkdown:'LEAF_BODY_CANARY'})]});
    database.projections.ensure(['papers']);
    const projected=database.one(database.query.selectFrom('paper_read_model').select('data').where('id','=','identity-paper'))!;
    assert.deepEqual(JSON.parse(projected.data).snapshot,[{id:'group::leaf',type:'short_answer',sourceQuestionId:'group',groupId:'group'}]);
    assert.ok(!projected.data.includes('LEAF_BODY_CANARY'));
  }finally{database.close();}
});

test('explicit rebuild preserves byte-identical entities, notes, dates, statuses, settings and AI key', () => {
  const database = new DatabaseConnection(':memory:');
  try {
    seed(database); const originals = canonical(database); database.projections.refreshAll(); const expected = derived(database);
    database.projections.rebuild(); database.projections.rebuild();
    assert.deepEqual(canonical(database), originals); assert.deepEqual(derived(database), expected);
    assert.equal(database.getRecord<any>('questions', 'question-original').status, 'pending');
    assert.equal(database.getRecord<any>('study', 'question-original').nextReviewAt, date);
    assert.ok(database.getRecord<any>('study', 'question-original').notes.includes('个人笔记'));
    assert.equal(database.getRecord<any>('ai_settings', 'global').key, 'sk-test-projection-only-never-a-real-key');
  } finally { database.close(); }
});

test('external native writes and repeated UPSERTs persist one dirty marker and refresh exact references', async t => {
  const path = await temporary(t), database = new DatabaseConnection(path);
  seed(database); database.projections.refreshAll();
  const external = new DatabaseSync(path);
  try {
    const upsert = external.prepare('INSERT INTO questions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
    for (let index = 0; index < 8; index++) upsert.run('question-external', JSON.stringify(question({ id: 'question-external', title: `外部最新 ${index}`, stemMarkdown: image(`asset-external-${index}`), status: 'draft' })));
    assert.deepEqual(pending(database), [{ source_table: 'questions', source_id: 'question-external' }]);
    external.prepare('INSERT INTO documents(id,data) VALUES(?,?)').run('document-external', JSON.stringify({ id: 'document-external', assetId: 'asset-external-pdf' }));
    database.projections.ensure(['questions']);
    assert.deepEqual(pending(database), [{ source_table: 'documents', source_id: 'document-external' }]);
    const latest = database.one(database.query.selectFrom('question_read_model').select('data').where('id', '=', 'question-external'))!;
    assert.equal(JSON.parse(latest.data).title, '外部最新 7');
    assert.deepEqual(references(database).filter(row => row.source_id === 'question-external').map(row => row.asset_id), ['asset-external-7']);
    external.prepare('UPDATE questions SET id=?,data=? WHERE id=?').run('question-renamed', JSON.stringify(question({ id: 'question-renamed', title: '外部重命名', stemMarkdown: image('asset-renamed') })), 'question-external');
    database.projections.ensure(['questions']);
    assert.equal(database.one(database.query.selectFrom('question_read_model').select('id').where('id', '=', 'question-external')), undefined);
    assert.ok(database.one(database.query.selectFrom('question_read_model').select('id').where('id', '=', 'question-renamed')));
    external.prepare('DELETE FROM questions WHERE id=?').run('question-renamed'); database.projections.refreshAll();
    assert.equal(database.one(database.query.selectFrom('question_read_model').select('id').where('id', '=', 'question-renamed')), undefined);
    assert.ok(!references(database).some(row => row.source_id === 'question-renamed' || row.source_id === 'question-external'));
    assert.ok(references(database).some(row => row.source_id === 'document-external' && row.asset_id === 'asset-external-pdf'));
    assert.deepEqual(pending(database), []);
  } finally { external.close(); database.close(); }
});

test('outer rollback restores canonical rows, derived indexes, dirty queue and asset relations together', () => {
  const database = new DatabaseConnection(':memory:');
  try {
    seed(database); database.projections.refreshAll(); const originals = canonical(database), expected = derived(database);
    assert.throws(() => database.transaction(() => {
      database.putRecord('questions', 'question-original', question({ title: '事务中的新题目', stemMarkdown: image('asset-uncommitted'), status: 'published' }));
      database.putRecord('documents', 'uncommitted-document', { id: 'uncommitted-document', assetId: 'asset-uncommitted-pdf' });
      database.deleteRecord('papers', 'paper-original');
      database.transaction(() => {
        database.putRecord('ai_settings', 'global', { id: 'global', key: 'uncommitted-key' });
        database.projections.refreshAll();
        assert.ok(references(database).some(row => row.asset_id === 'asset-uncommitted'));
        assert.equal(database.one(database.query.selectFrom('paper_read_model').select('id').where('id', '=', 'paper-original')), undefined);
      });
      throw new Error('rollback both canonical and projections');
    }), /rollback both canonical and projections/);
    assert.deepEqual(canonical(database), originals); assert.deepEqual(derived(database), expected);
    database.projections.refreshAll(); assert.deepEqual(derived(database), expected);
  } finally { database.close(); }
});

test('asset projection distinguishes exact IDs and ignores payload text, invalid suffixes and remote URLs', () => {
  const database = new DatabaseConnection(':memory:');
  try {
    database.putRecord('questions', 'exact-references', question({
      id: 'exact-references',
      stemMarkdown: `${image('asset-10')} ${image('asset-10')} ![坏链接](/api/assets/invalid-suffix/content-extra) ![远程](https://example.invalid/api/assets/remote-only/content)`,
      explanationMarkdown: '仅出现asset-1这个名称并不构成引用。',
      parts: [{ id: 'part', assetId: 'asset-part' }],
      dataBase64: '/api/assets/binary-payload/content',
    }));
    database.projections.refreshAll();
    assert.deepEqual(references(database).filter(row => row.source_id === 'exact-references').map(row => row.asset_id), ['asset-10', 'asset-part']);
  } finally { database.close(); }
});
