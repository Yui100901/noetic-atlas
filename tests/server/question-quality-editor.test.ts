import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/index.js';

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
