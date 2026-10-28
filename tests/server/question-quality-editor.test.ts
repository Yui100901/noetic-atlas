import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/index.js';

test('a scan finding and user report on the same question can be processed sequentially in either order',async t=>{
 const app=await buildApp({databasePath:':memory:',seedPath:'missing-independent-quality-seed',staticRoot:'missing-quality-web',native:true,dailyPushScheduler:false});t.after(()=>app.close());
 const api=async(url:string,body?:unknown,method:any=body===undefined?'GET':'POST',expected=200)=>{const response=await app.inject({url,method,...(body===undefined?{}:{payload:body})});assert.equal(response.statusCode,expected,response.body);return response.json();};
 for(const firstSource of ['scan','feedback']){
  const id='ORDER-'+firstSource;
  const question=await api('/api/questions',{id,title:'独立质量状态 '+firstSource,type:'short_answer',stemMarkdown:'解释事务整体提交或回滚。',answerMarkdown:'原子性。',sourceRefs:[{label:'占位地址',url:'https://example.org/placeholder'}]},'POST',201);
  const report=await api('/api/question-feedback',{questionId:id,kind:'answer',description:'需要核对事务概念表述。'},'POST',201);
  const scan=await api('/api/content-quality/scans',{filters:{questionId:id}},'POST',201);await api(`/api/content-quality/scans/${scan.id}/process`,{batchSize:1});
  const issues=(await api('/api/content-quality/issues?questionId='+id+'&status=all')).items;assert.equal(issues.length,2);
  const first=issues.find((issue:any)=>issue.origin===firstSource),second=issues.find((issue:any)=>issue.id!==first.id);
  await api(`/api/content-quality/issues/${first.id}/resolve`,{status:'resolved',note:'本项已核对并解决。',expectedUpdatedAt:first.updatedAt});
  const untouched=(await api(`/api/content-quality/issues/${second.id}`)).issue;
  assert.equal(untouched.updatedAt,second.updatedAt,'resolving a sibling must not invalidate this item version');assert.equal(untouched.status,'open');assert.equal(untouched.sourceChanged,false);
  await api(`/api/content-quality/issues/${second.id}/resolve`,{status:'confirmed',note:'本项确认仍需修订。',expectedUpdatedAt:second.updatedAt});
  const confirmed=(await api(`/api/content-quality/issues/${second.id}`)).issue;
  await api(`/api/content-quality/issues/${second.id}/resolve`,{status:'resolved',note:'本项也已解决。',expectedUpdatedAt:confirmed.updatedAt});
  assert.ok((await api('/api/content-quality/issues?questionId='+id+'&status=all')).items.every((issue:any)=>issue.status==='resolved'));
  assert.deepEqual(await api('/api/questions/'+id),question,'issue decisions must not update the saved question version');
  assert.equal((await api('/api/question-feedback/'+report.id)).status,'resolved');
 }
});

test('an expired resolved scan cannot block a current user report on the repaired question',async t=>{
 const app=await buildApp({databasePath:':memory:',seedPath:'missing-repaired-independent-quality-seed',staticRoot:'missing-quality-web',native:true,dailyPushScheduler:false});t.after(()=>app.close());
 const api=async(url:string,body?:unknown,method:any=body===undefined?'GET':'POST',expected=200)=>{const response=await app.inject({url,method,...(body===undefined?{}:{payload:body})});assert.equal(response.statusCode,expected,response.body);return response.json();};
 let question=await api('/api/questions',{id:'REPAIRED-PAIR',title:'修订后分别核查',type:'single_choice',stemMarkdown:'选择与事务整体性一致的描述。',options:[{key:'A',text:'全部提交或回滚'},{key:'B',text:'全部提交或回滚'}],correctAnswers:['A']},'POST',201);
 const scan=async()=>{const run=await api('/api/content-quality/scans',{filters:{questionId:question.id}},'POST',201);return api(`/api/content-quality/scans/${run.id}/process`,{batchSize:1});};
 await scan();const originalScan=(await api('/api/content-quality/issues?questionId='+question.id+'&status=all')).items[0];assert.equal(originalScan.rule,'duplicate_options');
 question=await api('/api/questions/'+question.id,{...question,options:[{key:'A',text:'全部提交或回滚'},{key:'B',text:'允许部分提交'}]},'PUT');
 await scan();const rechecked=(await api(`/api/content-quality/issues/${originalScan.id}`)).issue;assert.equal(rechecked.status,'stale');assert.equal(rechecked.sourceChanged,true);
 const resolvedScan=await api(`/api/content-quality/issues/${rechecked.id}/resolve`,{status:'resolved',note:'已修正重复选项并重扫当前版本。',expectedUpdatedAt:rechecked.updatedAt});
 assert.equal(resolvedScan.status,'resolved');assert.equal(resolvedScan.sourceChanged,true,'historical scan keeps its original evidence fingerprint');
 const feedback=await api('/api/question-feedback',{questionId:question.id,kind:'answer',description:'修订后另行提交的独立反馈。'},'POST',201);
 const current=(await api('/api/content-quality/issues/'+feedback.qualityIssueId)).issue;assert.equal(current.status,'open');assert.equal(current.sourceChanged,false);assert.equal(current.note,'');
 // Requiring an explicit basis is per finding, never inherited from its sibling.
 await api(`/api/content-quality/issues/${current.id}/resolve`,{status:'resolved',note:'',expectedUpdatedAt:current.updatedAt},'POST',400);
 const confirmed=await api(`/api/content-quality/issues/${current.id}/resolve`,{status:'confirmed',note:'单独核对当前反馈。',expectedUpdatedAt:current.updatedAt});
 const resolved=await api(`/api/content-quality/issues/${current.id}/resolve`,{status:'resolved',note:'当前反馈已逐项核对处理。',expectedUpdatedAt:confirmed.updatedAt});assert.equal(resolved.status,'resolved');
 assert.deepEqual((await api('/api/content-quality/issues/'+resolvedScan.id)).issue,resolvedScan,'another finding cannot change a closed scan state or version');
 assert.deepEqual(await api('/api/questions/'+question.id),question,'per-finding decisions cannot alter the saved question');
 assert.equal((await api('/api/question-feedback/'+feedback.id)).status,'resolved');
});

test('saved question edits require a current recheck before resolving prior evidence; group parts stay identifiable and decisions migrate',async t=>{
 const app=await buildApp({databasePath:':memory:',seedPath:'missing-editor-quality-seed',staticRoot:'missing-editor-quality-web',native:true,dailyPushScheduler:false});t.after(()=>app.close());
 const api=async(url:string,body?:unknown,method:any=body===undefined?'GET':'POST',expected=200)=>{const response=await app.inject({url,method,...(body===undefined?{}:{payload:body})});assert.equal(response.statusCode,expected,response.body);return response.json();};
 const sourceRefs=[{label:'事务参考',url:'https://www.postgresql.org/docs/current/tutorial-transactions.html'}];
 let question=await api('/api/questions',{id:'EDITOR-Q',title:'说明事务',type:'short_answer',stemMarkdown:'说明事务原子性。',answerMarkdown:'整体提交或回滚。',explanationMarkdown:'',sourceRefs:[{label:'待补充的占位来源',url:'https://example.org/placeholder'}]},'POST',201);
 const scan=async(id:string)=>{const run=await api('/api/content-quality/scans',{filters:{questionId:id}} , 'POST',201);return api(`/api/content-quality/scans/${run.id}/process`,{batchSize:1});};
 await scan(question.id);let items=(await api('/api/content-quality/issues?questionId=EDITOR-Q&status=all')).items;assert.equal(items.length,1);const issue=items[0];
 await api(`/api/content-quality/issues/${issue.id}/resolve`,{status:'resolved',note:'',expectedUpdatedAt:issue.updatedAt},'POST',400);
 question=await api('/api/questions/EDITOR-Q',{...question,explanationMarkdown:'事务任一部分失败时，应按原子性约束整体回滚。',sourceRefs},'PUT');
 const stale=await api(`/api/content-quality/issues/${issue.id}/resolve`,{status:'resolved',note:'已修正占位来源。',expectedUpdatedAt:issue.updatedAt},'POST',409);assert.equal(stale.error.code,'QUALITY_SOURCE_CHANGED');
 await scan(question.id);const checked=(await api(`/api/content-quality/issues/${issue.id}`)).issue;assert.equal(checked.status,'stale');
 const result=await api(`/api/content-quality/issues/${issue.id}/resolve`,{status:'resolved',note:'已修正来源并重新检查保存版本。',expectedUpdatedAt:checked.updatedAt});assert.equal(result.status,'resolved');
 const conflict=await api(`/api/content-quality/issues/${issue.id}/resolve`,{status:'dismissed',note:'旧版本操作不能覆盖结论。',expectedUpdatedAt:checked.updatedAt},'POST',409);assert.equal(conflict.error.code,'QUALITY_ISSUE_VERSION_CONFLICT');
 const group=await api('/api/questions',{id:'EDITOR-GROUP',title:'组合材料',type:'group',stemMarkdown:'阅读公共材料。',sourceRefs,parts:[{id:'first',title:'第一小题',type:'short_answer',stemMarkdown:'解释A。\n\n学习说明：此行测试题干冗余。',answerMarkdown:'A的说明。',explanationMarkdown:''},{id:'second',title:'第二小题',type:'true_false',stemMarkdown:'原子性等于全部成功或回滚。',correctAnswers:['true'],answerMarkdown:'正确。',explanationMarkdown:'依据事务的整体性。'}]},'POST',201);
 await scan(group.id);items=(await api('/api/content-quality/issues?questionId=EDITOR-GROUP&status=all')).items;assert.ok(items.some((value:any)=>value.partId==='first'));assert.ok(!items.some((value:any)=>value.partId==='second'));
 const migrated=await api('/api/export');assert.equal(migrated.qualityIssues.find((value:any)=>value.id===issue.id).status,'resolved');assert.equal(migrated.questions.find((value:any)=>value.id===question.id).explanationMarkdown,question.explanationMarkdown);
 assert.equal((await api('/api/questions/EDITOR-Q')).status,'pending','quality triage must not publish the question');
});
