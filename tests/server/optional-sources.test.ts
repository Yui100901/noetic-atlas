import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/index.js';
import {Store} from '../../server/core/store.js';
import {questionSchema} from '../../server/core/validation.js';
import {inspectQuestionQuality} from '../../server/modules/content-quality/rules.js';
import {retireMissingSourceIssues} from '../../server/modules/content-quality/maintenance.js';

const stamp='2026-10-27T00:00:00.000Z';
const authored={id:'NO-SOURCE',type:'short_answer' as const,title:'解释原子性',stemMarkdown:'说明事务的原子性。',answerMarkdown:'整体提交或整体回滚。',explanationMarkdown:'不能将部分成功作为完整事务的提交结果。'};

test('source metadata may be omitted or empty while supplied invalid metadata remains rejected',()=>{
  for(const input of [authored,{...authored,sourceRefs:[]}]){
    const q=questionSchema.parse(input);
    assert.deepEqual(q.sourceRefs,[]);
    assert.deepEqual(inspectQuestionQuality(q),[]);
  }
  const missingExplanation=questionSchema.parse({...authored,sourceRefs:[],explanationMarkdown:''});
  assert.deepEqual(inspectQuestionQuality(missingExplanation),[],'independent explanation and reference fields are both optional');
  assert.throws(()=>questionSchema.parse({...authored,sourceRefs:[{label:'私有路径',url:'file:///private.txt'}]}));
  assert.throws(()=>questionSchema.parse({...authored,sourceRefs:'broken'}));
});

test('creating, saving, approving and scanning a question never requires a reference',async t=>{
  const app=await buildApp({databasePath:':memory:',seedPath:'missing-optional-source-seed',staticRoot:'missing-web',native:true,dailyPushScheduler:false});t.after(()=>app.close());
  const api=async(method:'GET'|'POST'|'PUT',url:string,payload?:unknown,status=200)=>{
    const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,status,response.body);return response.json();
  };
  let question=await api('POST','/api/questions',authored,201);assert.deepEqual(question.sourceRefs,[]);assert.equal(question.status,'pending');
  question=await api('PUT','/api/questions/'+question.id,{...question,title:'更新后的事务概念',sourceRefs:[]});assert.deepEqual(question.sourceRefs,[]);
  await api('POST','/api/questions/review',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});
  const run=await api('POST','/api/content-quality/scans',{filters:{questionId:question.id,status:'all'}},201);
  const done=await api('POST',`/api/content-quality/scans/${run.id}/process`,{batchSize:1});assert.equal(done.status,'completed');assert.equal(done.findings,0);
  assert.equal((await api('GET','/api/content-quality/issues?questionId='+question.id+'&status=all')).total,0);
  assert.equal((await api('GET','/api/questions/'+question.id)).status,'published');
});

function legacyIssue(id:string,status:'open'|'confirmed'|'resolved'|'dismissed'|'stale',rule='missing_source') {
  return{id,questionId:authored.id,questionTitle:authored.title,domainIds:[],contentFingerprint:'a'.repeat(64),ruleVersion:'2026-10-26.1',rule,severity:'notice',status,message:'旧规则提示',evidence:'旧检查证据',suggestion:'旧规则建议',relatedQuestions:[],createdAt:stamp,updatedAt:stamp,lastDetectedAt:stamp,scanId:'old-scan',note:status==='resolved'?'保留当时处理说明':''};
}
test('retiring missing-source findings is idempotent and leaves sources, feedback, study and historical scan evidence untouched',t=>{
  const store=new Store(':memory:');t.after(()=>store.db.close());const q=questionSchema.parse(authored);store.put('questions',authored.id,q);
  store.putStudy({...store.study(authored.id),favorite:true,notes:'私人笔记'});
  const oldScan={id:'old-scan',findings:8,ruleCounts:{missing_source:5,missing_explanation:3}};
  store.put('quality_scans',oldScan.id,oldScan);store.put('question_feedback','feedback1',{id:'feedback1',questionId:authored.id,description:'用户报告另一个问题'});
  for(const [index,status]of ['open','confirmed','resolved','dismissed','stale'].entries())store.put('quality_issues','old'+index,legacyIssue('old'+index,status as any));
  store.put('quality_issues','keep',legacyIssue('keep','open','missing_explanation'));
  const before={question:store.require('questions',authored.id),study:store.all('study'),feedback:store.all('question_feedback'),scan:store.require('quality_scans',oldScan.id),keptIssue:store.require('quality_issues','keep')};
  assert.equal(retireMissingSourceIssues(store),5);assert.equal(retireMissingSourceIssues(store),0);
  assert.deepEqual(store.all('quality_issues'),[before.keptIssue]);
  assert.deepEqual({question:store.require('questions',authored.id),study:store.all('study'),feedback:store.all('question_feedback'),scan:store.require('quality_scans',oldScan.id),keptIssue:store.require('quality_issues','keep')},before);
});
test('retirement participates in the caller transaction and can be rolled back',t=>{
  const store=new Store(':memory:');t.after(()=>store.db.close());store.put('quality_issues','legacy',legacyIssue('legacy','open'));
  assert.throws(()=>store.transaction(()=>{assert.equal(retireMissingSourceIssues(store),1);throw Error('simulated migration failure');}),/simulated migration failure/);
  assert.ok(store.get('quality_issues','legacy'));assert.equal(retireMissingSourceIssues(store),1);
});
