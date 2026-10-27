import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Store,now} from '../../server/core/store.js';
import {ApiError,questionSchema} from '../../server/core/validation.js';
import type {QualityIssue,QualityQuestionGroup} from '../../shared/models/content-quality.js';
import {registerContentQualityRoutes} from '../../server/modules/content-quality/routes.js';
import {createQuestionFeedback} from '../../server/modules/quality-feedback/service.js';
import {createQualityScan,processQualityScan} from '../../server/modules/content-quality/service.js';

async function fixture(t:test.TestContext){
 const store=new Store(':memory:'),app=Fastify();
 app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApiError?error.status:500).send({error:{message:error.message}}));
 registerContentQualityRoutes(app,store);t.after(async()=>{await app.close();store.db.close();});
 store.put('domains','cs',{id:'cs',name:'计算机',description:'',sortOrder:0});store.put('categories','core',{id:'core',domainId:'cs',parentId:null,name:'基础',description:'',sortOrder:0});
 const put=(id:string,changes:Record<string,unknown>={})=>{const q=questionSchema.parse({id,title:'题目'+id,type:'single_choice',stemMarkdown:'PRIVATE_STEM_CANARY：选择整体提交或回滚的含义'+id,options:[{key:'A',text:'整体提交或回滚'},{key:'B',text:'整体提交或回滚'}],correctAnswers:['A'],answerMarkdown:'A',categoryIds:['core'],createdAt:now(),updatedAt:now(),...changes});store.put('questions',id,q);return q;};
 const report=(questionId:string,description:string,partId?:string)=>createQuestionFeedback(store,{questionId,kind:'answer',description,...(partId?{partId}:{})});
 const scan=(questionId?:string)=>{const run=createQualityScan(store,{...(questionId?{questionId}:{}),status:'all'});return processQualityScan(store,run.id,100);};
 const api=async(url:string,payload?:unknown)=>{const response=await app.inject({url,method:payload?'POST':'GET',...(payload?{payload}:{})});assert.equal(response.statusCode,200,response.body);return response.json();};
 return{store,app,put,report,scan,api};
}

test('one question contains independent user feedback and scan issues with explicit totals',async t=>{
 const f=await fixture(t),question=f.put('Q1');const a=f.report('Q1','第一条需要核查的反馈'),b=f.report('Q1','另一条独立反馈');f.scan('Q1');
 const page=await f.api('/api/content-quality/questions');assert.equal(page.total,1);assert.equal(page.items.length,1);
 const group=page.items[0] as QualityQuestionGroup;assert.equal(group.questionId,'Q1');assert.equal(group.issueCount,3);assert.equal(group.matchedIssueCount,3);assert.equal(group.activeIssueCount,3);assert.deepEqual(group.origins,['feedback','scan']);assert.equal(group.counts.open,3);assert.equal(group.sourceAvailable,true);assert.ok(!JSON.stringify(group).includes('PRIVATE_STEM_CANARY'));
 const issue=f.store.require<QualityIssue>('quality_issues',a.qualityIssueId!);
 await f.api(`/api/content-quality/issues/${issue.id}/resolve`,{status:'resolved',note:'只处理这一项反馈',expectedUpdatedAt:issue.updatedAt});
 const updated=(await f.api('/api/content-quality/questions')).items[0];assert.equal(updated.issueCount,3);assert.equal(updated.activeIssueCount,2);assert.equal(updated.matchedIssueCount,2);assert.equal(updated.counts.resolved,1);assert.equal(f.store.require<QualityIssue>('quality_issues',b.qualityIssueId!).status,'open');assert.equal(f.store.all<QualityIssue>('quality_issues').find(i=>i.origin==='scan')!.status,'open');
 assert.deepEqual(f.store.require('questions','Q1'),question);
 const overview=await f.api('/api/content-quality/overview');assert.equal(overview.totalQuestions,1);assert.equal(overview.activeQuestions,1);assert.equal(overview.totalIssues,3);assert.equal(overview.counts.resolved,1);
});

test('source, rule, status, search and domain filters match issues without discarding the other sources in a group',async t=>{
 const f=await fixture(t);f.put('Q1');const a=f.report('Q1','可搜索的精确反馈'),b=f.report('Q1','第二条反馈');const run=f.scan('Q1');
 for(const suffix of ['origin=feedback','origin=scan','rule=duplicate_options','scanId='+run.id,'search='+encodeURIComponent('精确反馈'),'domainId=cs']){
  const page=await f.api('/api/content-quality/questions?'+suffix);assert.equal(page.total,1,suffix);const group=page.items[0];assert.equal(group.issueCount,3,suffix);assert.deepEqual(group.origins,['feedback','scan'],suffix);assert.equal(group.matchedIssueCount,suffix==='origin=feedback'?2:suffix==='domainId=cs'?3:1,suffix);
 }
 assert.equal((await f.api('/api/content-quality/questions?domainId=missing')).total,0);
 const issue=f.store.require<QualityIssue>('quality_issues',a.qualityIssueId!);await f.api(`/api/content-quality/issues/${issue.id}/resolve`,{status:'dismissed',note:'本条无需处理',expectedUpdatedAt:issue.updatedAt});
 const done=(await f.api('/api/content-quality/questions?status=dismissed')).items[0];assert.equal(done.matchedIssueCount,1);assert.equal(done.issueCount,3);assert.equal(done.activeIssueCount,2);
 const deep=(await f.api('/api/content-quality/questions?status=all&feedbackId='+b.id)).items[0];assert.equal(deep.matchedIssueCount,1);assert.equal(deep.issueCount,3);
});

test('root question titles and grouping remain correct across multiple group parts and deleted sources',async t=>{
 const f=await fixture(t);const q=f.put('GROUP',{title:'根题公共材料',type:'group',options:[],correctAnswers:[],parts:[{id:'one',title:'小题一',type:'single_choice',stemMarkdown:'选择一项。',options:[{key:'A',text:'相同'},{key:'B',text:'相同'}],correctAnswers:['A']},{id:'two',title:'小题二',type:'short_answer',stemMarkdown:'解释概念。'}]});
 f.report(q.id!,'小题一反馈','one');f.report(q.id!,'小题二反馈','two');f.scan(q.id);
 f.store.put('questions',q.id!,{...q,title:'当前根题标题'});
 let page=await f.api('/api/content-quality/questions');assert.equal(page.total,1);assert.equal(page.items[0].questionTitle,'当前根题标题');assert.equal(page.items[0].issueCount,3);
 f.store.remove('questions',q.id!);page=await f.api('/api/content-quality/questions');assert.equal(page.total,1);assert.equal(page.items[0].questionId,q.id);assert.equal(page.items[0].sourceAvailable,false);assert.ok(page.items[0].questionTitle);
});

test('database grouping happens before pagination and a busy question never repeats across pages',async t=>{
 const f=await fixture(t);
 for(let index=0;index<23;index++){const id='P'+String(index).padStart(2,'0');f.put(id,{type:'short_answer',options:[],correctAnswers:[]});for(let report=0;report<(index===0?25:2);report++)f.report(id,'分页反馈'+report);}
 const pages=await Promise.all([1,2,3].map(page=>f.api(`/api/content-quality/questions?pageSize=10&page=${page}`)));
 assert.deepEqual(pages.map(page=>page.total),[23,23,23]);assert.deepEqual(pages.map(page=>page.items.length),[10,10,3]);
 const ids=pages.flatMap(page=>page.items.map((row:QualityQuestionGroup)=>row.questionId));assert.equal(new Set(ids).size,23);assert.equal(ids.filter(id=>id==='P00').length,1);assert.equal(pages.flatMap(page=>page.items).find(row=>row.questionId==='P00').issueCount,25);
});

test('question summaries and overview are read-only and exclude retired checks from both totals',async t=>{
 const f=await fixture(t);f.put('Q1');f.report('Q1','需要核查');f.scan('Q1');
 const issue=f.store.all<QualityIssue>('quality_issues')[0]!;f.store.put('quality_issues','retired',{...issue,id:'retired',rule:'missing_explanation'});
 const before=[f.store.all('questions'),f.store.all('quality_issues'),f.store.all('question_feedback'),f.store.all('quality_scans')];
 let writes=0;const run=f.store.database.run.bind(f.store.database);f.store.database.run=((...args:Parameters<typeof run>)=>{writes++;return run(...args);}) as typeof run;
 const page=await f.api('/api/content-quality/questions?status=all'),overview=await f.api('/api/content-quality/overview');assert.equal(page.items[0].issueCount,2);assert.equal(overview.totalIssues,2);assert.equal(overview.totalQuestions,1);assert.equal(overview.activeQuestions,1);assert.equal(writes,0);
 assert.deepEqual([f.store.all('questions'),f.store.all('quality_issues'),f.store.all('question_feedback'),f.store.all('quality_scans')],before);
 for(const i of f.store.all<QualityIssue>('quality_issues').filter(i=>i.id!=='retired'))await f.api(`/api/content-quality/issues/${i.id}/resolve`,{status:'dismissed',note:'本次核查已结束',expectedUpdatedAt:i.updatedAt});
 assert.equal((await f.api('/api/content-quality/overview')).activeQuestions,0);assert.equal((await f.api('/api/content-quality/questions')).total,0);assert.equal((await f.api('/api/content-quality/questions?status=all')).total,1);
});

test('a retired-only feedback deep link cannot create an empty or duplicated current question group',async t=>{
 const f=await fixture(t);f.put('OLD');const feedback=f.report('OLD','旧规则AI证据');const original=f.store.require<QualityIssue>('quality_issues',feedback.qualityIssueId!);f.store.put('quality_issues',original.id,{...original,origin:'scan',rule:'missing_explanation'});
 const groups=await f.api('/api/content-quality/questions?status=all&feedbackId='+feedback.id);assert.equal(groups.total,0);assert.deepEqual(groups.items,[]);
 const history=await f.api('/api/content-quality/issues?status=all&feedbackId='+feedback.id);assert.equal(history.total,1);assert.equal(history.items[0].id,original.id);
});

test('legacy feedback origin is consistent in item views, source filters and question summaries',async t=>{
 const f=await fixture(t);f.put('LEGACY');
 const first=f.report('LEGACY','缺省来源的历史反馈'),second=f.report('LEGACY','规则仍为反馈的历史记录');f.scan('LEGACY');
 for(const [feedback,origin]of [[first,undefined],[second,'scan']]as const){const issue=f.store.require<QualityIssue>('quality_issues',feedback.qualityIssueId!);const legacy={...issue,origin};f.store.put('quality_issues',issue.id,legacy);}
 const feedbackItems=await f.api('/api/content-quality/issues?origin=feedback');assert.equal(feedbackItems.total,2);assert.ok(feedbackItems.items.every((issue:QualityIssue)=>issue.origin==='feedback'&&issue.rule==='user_feedback'));
 const scanItems=await f.api('/api/content-quality/issues?origin=scan');assert.equal(scanItems.total,1);assert.equal(scanItems.items[0].rule,'duplicate_options');
 const feedbackGroup=(await f.api('/api/content-quality/questions?origin=feedback')).items[0]as QualityQuestionGroup;assert.equal(feedbackGroup.matchedIssueCount,2);assert.equal(feedbackGroup.issueCount,3);assert.deepEqual(feedbackGroup.origins,['feedback','scan']);
 const scanGroup=(await f.api('/api/content-quality/questions?origin=scan')).items[0]as QualityQuestionGroup;assert.equal(scanGroup.matchedIssueCount,1);assert.deepEqual(scanGroup.origins,['feedback','scan']);
 const legacy=f.store.require<QualityIssue>('quality_issues',first.qualityIssueId!);const feedbackCount=f.store.all('question_feedback').length;
 const context=await f.api(`/api/content-quality/issues/${legacy.id}/review-context`,{expectedUpdatedAt:legacy.updatedAt});assert.equal(context.feedback.id,first.id);assert.equal(f.store.all('question_feedback').length,feedbackCount,'review reuses the original report instead of creating a second context');
});

test('closed high severity does not overshadow the current unresolved severity',async t=>{
 const f=await fixture(t);f.put('SEVERITY');const feedback=f.report('SEVERITY','待核查反馈');f.scan('SEVERITY');
 const report=f.store.require<QualityIssue>('quality_issues',feedback.qualityIssueId!);f.store.put('quality_issues',report.id,{...report,severity:'notice'});
 const scan=f.store.all<QualityIssue>('quality_issues').find(issue=>issue.origin==='scan')!;f.store.put('quality_issues',scan.id,{...scan,severity:'error',status:'resolved'});
 const group=(await f.api('/api/content-quality/questions')).items[0]as QualityQuestionGroup;assert.equal(group.issueCount,2);assert.equal(group.activeIssueCount,1);assert.equal(group.severity,'notice');assert.equal(group.counts.resolved,1);
});
