import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/index.js';
import {BLANK_LINE} from '../../shared/questions/blank-markers.js';
import {Store} from '../../server/core/store.js';
import {questionSchema} from '../../server/core/validation.js';
import {examQuestion,buildPaper,type StoredPaper} from '../../server/modules/practice/service.js';
import {paperExportDocument} from '../../server/modules/transfer/exports.js';

const blank={id:'FORMAT',title:'坐标名称是{{answer}}。',type:'fill_blank',stemMarkdown:'坐标名称是{{answer}}。\n\n`{{answer}}`',blanks:[{id:'b',label:'名称',answers:['纬度']}]};
test('question writes and bulk imports normalize fill markers without changing answer templates',async t=>{
  const app=await buildApp({databasePath:':memory:',seedPath:'missing-format-seed',staticRoot:'missing-format-web',native:true,dailyPushScheduler:false});t.after(()=>app.close());
  const create=await app.inject({method:'POST',url:'/api/questions',payload:{...blank,answerMarkdown:'代码 `{{answer}}` 与答案保持原样'}});
  assert.equal(create.statusCode,201,create.body);const q=create.json();
  assert.equal(q.title,'坐标名称是'+BLANK_LINE+'。');assert.equal(q.stemMarkdown,'坐标名称是'+BLANK_LINE+'。\n\n`{{answer}}`');
  assert.equal(q.answerMarkdown,'代码 `{{answer}}` 与答案保持原样');assert.equal(q.status,'pending');
  const update=await app.inject({method:'PUT',url:'/api/questions/FORMAT',payload:{...q,stemMarkdown:'再问{{blank_1}}。'}});assert.equal(update.statusCode,200,update.body);assert.equal(update.json().stemMarkdown,'再问'+BLANK_LINE+'。');
  const template=(await app.inject('/api/questions/import-template')).json();
  // Use the supported template envelope; newly authored questions always wait for review.
  const bulk=await app.inject({method:'POST',url:'/api/questions/bulk-import',payload:{confirmed:true,data:{...template,questions:[{...blank,id:'BULK'}]}}});
  assert.equal(bulk.statusCode,201,bulk.body);assert.equal(bulk.json().items[0].stemMarkdown,'坐标名称是'+BLANK_LINE+'。\n\n`{{answer}}`');
});
test('frozen historical snapshots export readable blanks without being rewritten',t=>{
  const store=new Store(':memory:');t.after(()=>store.db.close());
  const q={...questionSchema.parse({...blank,status:'published'}),id:blank.id};store.put('questions',q.id,q);
  const paper=buildPaper(store,{id:'frozen',title:'旧题集',mode:'manual',questionIds:[q.id],scoring:{enabled:false}}) as StoredPaper;
  const original=JSON.stringify(paper);
  const displayed=examQuestion(q as any);assert.equal(displayed.title,'坐标名称是'+BLANK_LINE+'。');assert.equal(displayed.stemMarkdown,'坐标名称是'+BLANK_LINE+'。\n\n`{{answer}}`');
  for(const mode of ['blank','answers'] as const){const exported=paperExportDocument(paper,mode);assert.equal(exported.questions[0].stemMarkdown,'坐标名称是'+BLANK_LINE+'。\n\n`{{answer}}`');assert.ok(exported.markdown.includes(BLANK_LINE));}
  assert.equal(JSON.stringify(paper),original);assert.equal(store.require('questions',q.id).stemMarkdown,blank.stemMarkdown);
});
