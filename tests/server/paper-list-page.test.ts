import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../server/index.js';
import { Store } from '../../server/core/store.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import { questionSchema, parse } from '../../server/core/validation.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import { paperListPage, paperListPageQuery, paperListPageQuerySchema, paperMetadata } from '../../server/modules/practice/paper-list.js';
import type { StoredPaper } from '../../server/modules/practice/service.js';

const stamp = '2026-10-28T00:00:00.000Z';
const question = parse(questionSchema, { id: 'Q-PAGE', title: '概念', type: 'short_answer', stemMarkdown: 'CANONICAL_STEM_NEVER_IN_LIST'.repeat(100), answerMarkdown: 'PRIVATE_ANSWER', status: 'published' });
function paper(id: string, extra: Partial<StoredPaper> = {}): StoredPaper {
  return { id, title: `题集 ${id}`, mode: 'manual', description: '目录说明', questionIds: [question.id], questionCount: 1, filters: null, snapshot: [question], scoring: normalizeScoring([question], { enabled: false }), organization: 'other', domainId: null, archived: false, version: 1, createdAt: stamp, updatedAt: stamp, ...extra };
}
async function fixture(t: test.TestContext) {
  let database: DatabaseConnection | undefined;
  const original = DatabaseConnection.prototype.all;
  const capture = t.mock.method(DatabaseConnection.prototype, 'all', function (this: DatabaseConnection, query: Parameters<typeof original>[0]) { database ||= this; return original.call(this, query); });
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'missing-paper-page-web', seedPath: 'missing-paper-page-seed', dailyPushScheduler: false, native: true });
  capture.mock.restore(); t.after(() => app.close()); assert.ok(database);
  const api = async (url: string, status = 200) => { const response = await app.inject(url); assert.equal(response.statusCode, status, response.body); return response.json(); };
  return { app, database, api };
}

test('paper card page filters and counts in the database while keeping equal-date insertion order', async t => {
  const { database, api } = await fixture(t), values = [];
  for (let index = 0; index < 27; index++) {
    const value = paper(`P-${27 - index}`, { title: `ÉCOLE 南京 100%_ 题集 ${index}`, description: '大段目录说明'.repeat(1000), archived: index % 7 === 0, organization: index % 3 === 0 ? 'domain' : 'other', domainId: index % 3 === 0 ? 'computer' : null });
    if (index === 1) { delete value.organization; delete (value as Partial<StoredPaper>).archived; }
    database.putRecord('papers', value.id, value); values.push(value);
  }
  const expected = values.filter(value => !value.archived), first = await api('/api/papers/page?page=1&pageSize=10');
  assert.equal(first.total, expected.length); assert.equal(first.page, 1); assert.equal(first.pageSize, 10);
  assert.deepEqual(first.items.map((item: any) => item.id), expected.slice(0, 10).map(value => value.id));
  assert.equal(first.items[0].organization, 'other'); assert.equal(first.items[0].archived, false);
  assert.ok(first.items.every((item: any) => item.description.length <= 1000));
  assert.deepEqual(Object.keys(first.items[0].scoring).sort(), ['enabled','scheme','totalPoints','objectivePoints','subjectivePoints'].sort());
  assert.doesNotMatch(JSON.stringify(first), /questionIds|questionPoints|snapshot|filters|CANONICAL_STEM|PRIVATE_ANSWER/);
  const next = await api('/api/papers/page?page=2&pageSize=10'); assert.deepEqual(next.items.map((item: any) => item.id), expected.slice(10, 20).map(value => value.id));
  const outside = await api('/api/papers/page?page=999&pageSize=10'); assert.equal(outside.page, 3); assert.equal(outside.items.length, expected.length - 20);
  const domain = await api('/api/papers/page?organization=domain&domainId=computer&archived=true&pageSize=10'); assert.equal(domain.total, 9);
  const other = await api('/api/papers/page?organization=other'); assert.equal(other.total, expected.filter(value => value.organization !== 'domain').length);
  const unicode = await api('/api/papers/page?search='+encodeURIComponent('école 南京 100%_')); assert.equal(unicode.total, expected.length);
  const noMatch = await api('/api/papers/page?search='+encodeURIComponent("%_' OR 1=1 --")); assert.equal(noMatch.total, 0); assert.equal(noMatch.page, 1);
  assert.equal((await api('/api/papers?archived=true')).length, values.length);
});

test('paper paging validates public bounds and publishes exact lightweight OpenAPI contracts', async t => {
  const { api } = await fixture(t);
  for (const query of ['page=0','page=1.5','pageSize=200','archived=1','organization=invalid','domainId=','search='+ 'a'.repeat(1001),'extra=true','page=1&page=2']) await api('/api/papers/page?'+query,400);
  const spec = await api('/api/openapi.json'), operation = spec.paths['/api/papers/page'].get;
  const parameters = Object.fromEntries(operation.parameters.filter((item: any) => item.in === 'query').map((item: any) => [item.name, item.schema]));
  assert.equal(parameters.search.maxLength,1000); assert.equal(parameters.page.minimum,1); assert.deepEqual(parameters.organization.enum,['all','domain','other']);
  const output = operation.responses['200'].content['application/json'].schema; assert.ok(output.required.includes('items')); assert.equal(output.properties.items.items.additionalProperties,false);
  assert.equal(output.properties.items.items.properties.questionIds,undefined); assert.equal(output.properties.items.items.properties.scoring.properties.questionPoints,undefined);
  assert.ok(spec.paths['/api/papers/{id}/metadata'].get.responses['200'].content['application/json'].schema.required.includes('archived'));
});

test('warm paper card paging decodes at most its page and metadata avoids all snapshots and scoring', async t => {
  const { database, api } = await fixture(t);
  for(let index=0;index<35;index++)database.putRecord('papers','P'+index,paper('P'+index));
  database.projections.ensure(['papers']);
  const all=database.all.bind(database),one=database.one.bind(database),decoded:string[]=[];
  const inspect=(builder:any,rows:any[])=>{const sql='compile'in builder?builder.compile().sql:builder.sql;assert.doesNotMatch(sql, /select\s+"original"\."data"/);for(const row of rows)if(typeof row?.data==='string')decoded.push(row.data);};
  database.all=((builder:any)=>{const rows=all(builder);inspect(builder,rows);return rows;}) as typeof database.all;
  database.one=((builder:any)=>{const row=one(builder);inspect(builder,row?[row]:[]);return row;}) as typeof database.one;
  try{
    const page=await api('/api/papers/page?page=2&pageSize=10'); assert.equal(page.items.length,10);assert.equal(decoded.length,10);assert.ok(decoded.every(value=>!value.includes('CANONICAL_STEM')));
    decoded.length=0; const metadata=await api('/api/papers/P5/metadata');assert.deepEqual(metadata,{id:'P5',title:'题集 P5',version:1,archived:false});assert.equal(decoded.length,0);
    await api('/api/papers/no-such-paper/metadata',404); await api('/api/papers/P5/metadata?unknown=1',400);
  }finally{database.all=all;database.one=one;}
  const query=paperListPageQuery({database} as Store,parse(paperListPageQuerySchema,{domainId:'computer'}));
  const plan=database.explain(query.clearSelect().clearOrderBy().select(eb=>eb.fn.countAll().as('count')));
  assert.ok(plan.some((row:any)=>String(row.detail).includes('paper_read_domain_updated_idx')));
});

test('paper card projection observes updates and deletes, rollback and reopening without changing snapshots', async t => {
  const folder=await mkdtemp(join(tmpdir(),'atlas-paper-page-'));t.after(()=>rm(folder,{recursive:true,force:true}));const path=join(folder,'portable.sqlite');let store=new Store(path);
  store.put('papers','P',paper('P'));const original=store.database.getRecord('papers','P');assert.equal(paperListPage(store,parse(paperListPageQuerySchema,{})).total,1);
  assert.throws(()=>store.transaction(()=>{store.put('papers','P',paper('P',{title:'应回滚',archived:true}));assert.equal(paperListPage(store,parse(paperListPageQuerySchema,{})).total,0);throw Error('abort');}),/abort/);
  assert.deepEqual(store.database.getRecord('papers','P'),original);assert.equal(paperMetadata(store,'P').title,'题集 P');
  store.put('papers','P',paper('P',{title:'持久化后的新名称',organization:'domain',domainId:'computer',version:2}));store.db.close();store=new Store(path);
  try{const page=paperListPage(store,parse(paperListPageQuerySchema,{search:'新名称',organization:'domain',domainId:'computer'}));assert.equal(page.total,1);assert.equal(page.items[0]!.version,2);assert.equal(store.require<StoredPaper>('papers','P').snapshot[0]!.stemMarkdown,question.stemMarkdown);
    store.remove('papers','P');assert.equal(paperListPage(store,parse(paperListPageQuerySchema,{})).total,0);assert.throws(()=>paperMetadata(store,'P'),/记录不存在/);
  }finally{store.db.close();}
});
