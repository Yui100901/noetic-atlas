import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validatePack,asShare} from '../../scripts/content/manage.js';
import {Store} from '../../server/core/store.js';
import {planShareImport,importShare} from '../../server/modules/sharing/routes.js';
import {inspectQuestionQuality} from '../../server/modules/content-quality/rules.js';
test('author packs and portable sharing accept schema-optional prose and taxonomy without weakening answer-key validation',t=>{
 const raw=JSON.parse(readFileSync('tests/fixtures/driving-content.json','utf8'));
 raw.questions=raw.questions.map((q:any)=>({...q,sourceRefs:[],answerMarkdown:'',explanationMarkdown:'',categoryIds:[],tagIds:[]}));
 const pack=validatePack(raw),store=new Store(':memory:');t.after(()=>store.db.close());
 // Normalization may infer a built-in method tag, but callers need not supply
 // either classification field for the pack to validate and import.
 for(const q of pack.questions)assert.deepEqual(q.categoryIds,[]);
 const share=asShare(pack,'原创练习'),preview=planShareImport(store,share);importShare(store,share,preview.preview.fingerprint);
 for(const q of store.all<any>('questions')){assert.deepEqual(q.sourceRefs,[]);assert.equal(q.answerMarkdown,'');assert.equal(q.explanationMarkdown,'');assert.deepEqual(q.categoryIds,[]);assert.ok(!inspectQuestionQuality(q).some(issue=>issue.rule==='missing_source'||issue.rule==='missing_explanation'));assert.equal(q.status,'pending');}
 const invalid=structuredClone(raw);invalid.questions[0].correctAnswers=['MISSING'];assert.throws(()=>validatePack(invalid));
});
