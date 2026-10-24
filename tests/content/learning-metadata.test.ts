import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLearningEnvelope, cleanLearningRecord } from '../../shared/questions/learning-records.js';
import { cleanStoredLearningMetadata } from '../../server/modules/questions/learning-metadata.js';
import { Store } from '../../server/core/store.js';
import { importData, exportData } from '../../server/modules/transfer/migration.js';
import { parse, questionSchema, filtersSchema } from '../../server/core/validation.js';
import { paperDraftStateSchema } from '../../server/modules/practice/paper-drafts.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';

const stamp = '2026-10-23T00:00:00.000Z';
const question = () => ({ ...parse(questionSchema, { id:'private-card', title:'个人学习题', type:'short_answer', stemMarkdown:'解释接口概念', answerMarkdown:'明确操作契约', collection:'personal', status:'published' }), id:'private-card', createdAt:stamp, updatedAt:stamp });
const draftState = () => ({ title:'个人复习', description:'保留原有计划', mode:'manual', organization:'other', domainId:'', questionIds:['private-card'], filters:{collection:'personal'}, random:{collection:'personal'}, count:1, enabled:false, total:100, objectivePercent:60, pointsByType:{...DEFAULT_SETTINGS.pointsByType}, overrides:{}, autoTotal:true });

test('retired metadata cleanup is scoped, immutable and idempotent, preserving personal material and unrelated priority values', () => {
  const legacy = {
    questions:[{...question(),resumePriority:'P0',title:'保留 priority 与 resumePriority 原文', custom:{priority:'用户资料'}}],
    papers:[{id:'p',filters:{priority:'P1',collection:'personal'},snapshot:[{...question(),resumePriority:'P2'}],scoring:{totalPoints:12}}],
    attempts:[{id:'a',questions:[{...question(),resumePriority:'P0'}],answers:{'private-card':{value:'我的回答'}},subjectiveScore:7,submittedAt:stamp}],
    paperDrafts:[{id:'d',state:{...draftState(),filters:{collection:'personal',priority:'P0'},random:{priority:'P1'}}}],
    documents:[{priority:'正文分类',bodyMarkdown:'resumePriority: P0'}],study:[{notes:'priority是普通术语',favorite:true}],
    configuration:{priority:'业务优先级'},
  };
  const original = structuredClone(legacy), cleaned = cleanLearningEnvelope(legacy);
  assert.deepEqual(legacy, original, 'cleanup must not mutate input objects');
  assert.equal(Object.hasOwn(cleaned.questions[0]!, 'resumePriority'), false);
  assert.equal(Object.hasOwn(cleaned.papers[0]!.filters, 'priority'), false);
  assert.equal(Object.hasOwn(cleaned.papers[0]!.snapshot[0]!, 'resumePriority'), false);
  assert.equal(Object.hasOwn(cleaned.attempts[0]!.questions[0]!, 'resumePriority'), false);
  assert.equal(Object.hasOwn(cleaned.paperDrafts[0]!.state.filters, 'priority'), false);
  assert.equal(Object.hasOwn(cleaned.paperDrafts[0]!.state.random, 'priority'), false);
  assert.equal(cleaned.questions[0]!.collection,'personal');
  assert.deepEqual(cleaned.questions[0]!.custom,original.questions[0]!.custom);
  assert.deepEqual(cleaned.documents,original.documents);
  assert.deepEqual(cleaned.study,original.study);
  assert.deepEqual(cleaned.configuration,original.configuration);
  assert.deepEqual(cleaned.attempts[0]!.answers,original.attempts[0]!.answers);
  assert.equal(cleaned.attempts[0]!.subjectiveScore,7);
  assert.equal(cleanLearningEnvelope(cleaned), cleaned, 'already clean input needs no rewrite');
});

test('Store hides obsolete fields on reads and removes them on writes without silently migrating persistent rows', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const old = {...question(),resumePriority:'P0'};
  store.db.prepare('INSERT INTO questions(id,data) VALUES(?,?)').run(old.id,JSON.stringify(old));
  assert.equal(Object.hasOwn(store.question(old.id),'resumePriority'),false);
  assert.equal(Object.hasOwn(store.all('questions')[0],'resumePriority'),false);
  assert.equal(JSON.parse((store.db.prepare('SELECT data FROM questions WHERE id=?').get(old.id) as {data:string}).data).resumePriority,'P0');
  store.put('questions','second',{...old,id:'second'});
  assert.equal(Object.hasOwn(JSON.parse((store.db.prepare('SELECT data FROM questions WHERE id=?').get('second') as {data:string}).data),'resumePriority'),false);
  assert.equal(store.questions({collection:'personal',priority:'P2'}).length,2,'retired filters cannot select a resume-specific subset');
});

test('explicit SQLite cleanup preserves IDs, timestamps, answers and collections; repeated cleanup changes no rows', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const records = {
    questions:{...question(),resumePriority:'P0'},
    papers:{id:'paper',filters:{priority:'P1',collection:'personal'},snapshot:[{...question(),resumePriority:null}],createdAt:stamp,updatedAt:stamp},
    attempts:{id:'attempt',questions:[{...question(),resumePriority:'P2'}],answers:{'private-card':{value:'历史答卷'}},objectiveScore:2,subjectiveScore:3,startedAt:stamp,submittedAt:stamp},
    paper_drafts:{id:'draft',state:{...draftState(),filters:{priority:'P0'},random:{priority:'P1'}},updatedAt:stamp},
  };
  for (const [table,value] of Object.entries(records)) store.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?)`).run(value.id,JSON.stringify(value));
  assert.deepEqual(cleanStoredLearningMetadata(store.db),{questions:1,papers:1,attempts:1,learning_results:0,paper_drafts:1});
  for (const [table,value] of Object.entries(records)) {
    const row = store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(value.id) as {data:string};
    assert.deepEqual(JSON.parse(row.data), cleanLearningRecord(table,value));
  }
  assert.deepEqual(cleanStoredLearningMetadata(store.db),{questions:0,papers:0,attempts:0,learning_results:0,paper_drafts:0});
});

test('SQLite cleanup rolls back all table changes if a later update fails', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.db.prepare('INSERT INTO questions(id,data) VALUES(?,?)').run('q',JSON.stringify({id:'q',resumePriority:'P0'}));
  store.db.prepare('INSERT INTO papers(id,data) VALUES(?,?)').run('p',JSON.stringify({id:'p',filters:{priority:'P0'}}));
  store.db.exec("CREATE TRIGGER reject_metadata_update BEFORE UPDATE ON papers BEGIN SELECT RAISE(ABORT,'test rejection'); END");
  assert.throws(() => cleanStoredLearningMetadata(store.db), /test rejection/);
  assert.equal(JSON.parse((store.db.prepare('SELECT data FROM questions WHERE id=?').get('q') as {data:string}).data).resumePriority,'P0');
});

test('JSON backups normalize old filters and snapshots while restoring personal questions, notes and draft state', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const q = question(), state = draftState();
  const legacy = {schemaVersion:1,domains:[],categories:[],tags:[],documents:[],questions:[{...q,resumePriority:'P0'}],
    papers:[{id:'paper',title:'个人练习',description:'保留内容',mode:'random',questionIds:[q.id],filters:{priority:'P0',collection:'personal'},snapshot:[{...q,resumePriority:'P1'}]}],
    paperDrafts:[{id:'draft',context:'new',createdAt:stamp,updatedAt:stamp,state:{...state,filters:{...state.filters,priority:'P0'},random:{...state.random,priority:'P2'}}}],
    study:[{questionId:q.id,favorite:true,mastery:2,notes:'我的笔记 priority: 高',nextReviewAt:null,lastReviewedAt:stamp,wrongCount:1}],
  };
  importData(store,legacy);
  const exported = exportData(store) as any;
  assert.equal(exported.questions[0].collection,'personal');
  assert.equal(exported.questions[0].answerMarkdown,q.answerMarkdown);
  assert.equal(exported.questions[0].updatedAt,stamp);
  assert.equal(exported.study[0].notes,legacy.study[0]!.notes);
  assert.deepEqual(exported.papers[0].filters,{collection:'personal'});
  assert.deepEqual(exported.paperDrafts[0].state,state);
  assert.equal(Object.hasOwn(exported.questions[0],'resumePriority'),false);
  assert.equal(Object.hasOwn(exported.papers[0].snapshot[0],'resumePriority'),false);
});

test('current schemas expose only general study fields and reject obsolete authoring filters', () => {
  assert.equal(Object.hasOwn(questionSchema.shape,'resumePriority'),false);
  assert.equal(Object.hasOwn(filtersSchema.shape,'priority'),false);
  assert.equal(paperDraftStateSchema.safeParse({...draftState(),filters:{priority:'P0'}}).success,false);
  assert.equal(paperDraftStateSchema.safeParse(draftState()).success,true);
});
