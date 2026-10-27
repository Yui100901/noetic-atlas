import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../server/core/store.js';
import {questionSchema} from '../../server/core/validation.js';
import {getSettings} from '../../server/modules/settings/routes.js';
import {buildPaper} from '../../server/modules/practice/service.js';
import {completeContentRound} from '../../scripts/content/complete-content-round.js';
import {BLANK_LINE} from '../../shared/questions/blank-markers.js';

test('authorized all-bank review repairs only formatting and legacy field placement, preserving learning and frozen sets',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());getSettings(store);
 const old={...questionSchema.parse({id:'OLD-FILL',title:'坐标是{{answer}}。',type:'fill_blank',stemMarkdown:'坐标是{{answer}}。',blanks:[{id:'b',label:'坐标',answers:['纬度']}],answerMarkdown:'纬度。',status:'published'}),id:'OLD-FILL'};
 const pending={...questionSchema.parse({id:'OLD-PENDING',title:'机会成本',type:'short_answer',stemMarkdown:'说明机会成本。',answerMarkdown:'**回答：** 放弃的最佳替代方案的价值。\n\n**追问与误区：** 它不等于所有放弃方案价值相加。',status:'pending'}),id:'OLD-PENDING'};
 store.put('questions',old.id,old);store.put('questions',pending.id,pending);
 store.putStudy({...store.study(old.id),favorite:true,notes:'必须保留的私人笔记'});
 const paper=buildPaper(store,{id:'original',title:'冻结原卷',mode:'manual',questionIds:[old.id],scoring:{enabled:false}});store.put('papers',paper.id,paper);
 const beforeStudy=store.all('study'),beforePaper=store.require('papers',paper.id),beforeAnswer=structuredClone(old.blanks);
 const result=completeContentRound(store,[],false);
 assert.equal(result.approved,1);assert.equal(result.formattingFixed,1);assert.equal(result.explanationsSeparated,1);
 assert.equal(store.require('questions',old.id).stemMarkdown,'坐标是'+BLANK_LINE+'。');assert.equal(store.require('questions',old.id).title,'坐标是'+BLANK_LINE+'。');
 assert.deepEqual(store.require('questions',old.id).blanks,beforeAnswer);assert.equal(store.require('questions',pending.id).status,'published');
 const moved=store.require('questions',pending.id);assert.equal(moved.answerMarkdown+'\n\n'+moved.explanationMarkdown,pending.answerMarkdown);
 assert.deepEqual(store.all('study'),beforeStudy);assert.deepEqual(store.require('papers',paper.id),beforePaper);
 const again=completeContentRound(store,[],false);assert.equal(again.changed,0);assert.equal(again.approved,0);
});
test('invalid existing answers stop the whole review and roll back earlier question updates',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());getSettings(store);
 const valid={...questionSchema.parse({id:'A',title:'题A',type:'true_false',stemMarkdown:'这是判断题。',correctAnswers:['true'],status:'pending'}),id:'A'};
 store.put('questions','A',valid);store.put('questions','Z',{...valid,id:'Z',correctAnswers:['A']});
 assert.throws(()=>completeContentRound(store,[],false));assert.equal(store.require('questions','A').status,'pending');
});
