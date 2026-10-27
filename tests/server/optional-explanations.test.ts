import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Store} from '../../server/core/store.js';
import {buildApp} from '../../server/index.js';
import {questionSchema} from '../../server/core/validation.js';
import type {QualityIssue} from '../../shared/models/content-quality.js';
import {inspectQuestionQuality,qualityContentFingerprint} from '../../server/modules/content-quality/rules.js';
import {feedbackFingerprint} from '../../server/modules/quality-feedback/fingerprint.js';
import {retireMissingExplanationIssues} from '../../server/modules/content-quality/maintenance.js';
import {registerContentQualityRoutes} from '../../server/modules/content-quality/routes.js';

const timestamp='2026-10-27T00:00:00.000Z';
const base={id:'EXPLANATION-OPTIONAL',title:'解释事务原子性',type:'short_answer' as const,stemMarkdown:'事务原子性是什么意思？',answerMarkdown:'原子性要求事务整体提交或整体回滚；例如转账扣款后入账失败时，应撤销扣款，避免留下部分成功的状态。'};

test('standalone explanation is optional regardless of answer length or whether reasoning lives in the answer',()=>{
 for(const input of [base,{...base,explanationMarkdown:''},{...base,answerMarkdown:'原子性：整体提交或回滚。',explanationMarkdown:' \n\t '}]){
  const question=questionSchema.parse(input),before=structuredClone(question);
  assert.deepEqual(inspectQuestionQuality(question),[]);assert.deepEqual(question,before);
 }
 const malformed=questionSchema.parse({...base,sourceRefs:[{label:'占位地址仍应提示',url:'https://example.org/placeholder'}]});
 assert.ok(inspectQuestionQuality(malformed).some(finding=>finding.rule==='reference_placeholder'));
 const badChoice={...questionSchema.parse({...base,type:'single_choice',options:[{key:'A',text:'提交'},{key:'B',text:'回滚'}],correctAnswers:['A']}),correctAnswers:['C']};
 assert.ok(inspectQuestionQuality(badChoice).some(finding=>finding.rule==='structure'),'optional explanations must not weaken answer-key validation');
});

test('objective keys, accepted fill answers, and group material and leaves do not require a separate explanation',()=>{
 const cases=[
  {...base,type:'single_choice',options:[{key:'A',text:'整体提交或回滚'},{key:'B',text:'允许部分提交'}],correctAnswers:['A'],answerMarkdown:''},
  {...base,type:'multiple_choice',options:[{key:'A',text:'整体提交'},{key:'B',text:'整体回滚'},{key:'C',text:'保留半次操作'}],correctAnswers:['A','B'],answerMarkdown:''},
  {...base,type:'true_false',stemMarkdown:'原子性要求整体提交或回滚。',correctAnswers:['true'],answerMarkdown:''},
  {...base,type:'fill_blank',stemMarkdown:'事务原子性要求整体提交或____。',blanks:[{id:'b1',label:'操作',answers:['回滚']}],answerMarkdown:''},
  {...base,type:'group',stemMarkdown:'阅读转账先扣款再入账的事务。',answerMarkdown:'',parts:[
   {id:'explain',title:'说明原子性',type:'short_answer',stemMarkdown:'为什么不能只完成扣款？',answerMarkdown:'只扣款会留下部分成功，事务应整体提交或回滚。'},
   {id:'judge',title:'判断整体性',type:'true_false',stemMarkdown:'入账失败应撤销本事务扣款。',correctAnswers:['true']},
  ]},
 ];
 for(const input of cases){const question=questionSchema.parse(input);assert.deepEqual(inspectQuestionQuality(question),[],input.type);}
});

test('answer-contained explanations survive creation, editing, admission and scan without duplicate mandatory fields',async t=>{
 const app=await buildApp({databasePath:':memory:',seedPath:'missing-optional-explanation-seed',staticRoot:'missing-static',native:true,dailyPushScheduler:false});t.after(()=>app.close());
 const api=async(method:'GET'|'POST'|'PUT',url:string,payload?:unknown,status=200)=>{const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,status,response.body);return response.json();};
 let question=await api('POST','/api/questions',base,201);assert.equal(question.explanationMarkdown,'');assert.equal(question.answerMarkdown,base.answerMarkdown);
 question=await api('PUT','/api/questions/'+question.id,{...question,answerMarkdown:base.answerMarkdown+'提交后才向外部报告成功。',explanationMarkdown:''});
 await api('POST','/api/questions/review',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});
 const scan=await api('POST','/api/content-quality/scans',{filters:{questionId:question.id}},201),done=await api('POST',`/api/content-quality/scans/${scan.id}/process`,{batchSize:1});
 assert.equal(done.findings,0);assert.equal((await api('GET','/api/content-quality/issues?questionId='+question.id+'&status=all')).total,0);
 const saved=await api('GET','/api/questions/'+question.id);assert.equal(saved.status,'published');assert.equal(saved.explanationMarkdown,'');assert.equal(saved.answerMarkdown,question.answerMarkdown);
});

test('retiring explanation-only notices deletes unhandled machine findings but preserves human and AI evidence',async t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());const question=questionSchema.parse(base);store.put('questions',question.id,question);
 const issue=(id:string,status:QualityIssue['status']='open',note=''):QualityIssue=>({id,origin:'scan',questionId:question.id,questionTitle:question.title,domainIds:[],contentFingerprint:qualityContentFingerprint(question),ruleVersion:'2026-10-27.1',rule:'missing_explanation',severity:'notice',status,message:'旧版独立解析缺失提示',evidence:'旧版字段检查',suggestion:'旧版建议',relatedQuestions:[],createdAt:timestamp,updatedAt:timestamp,lastDetectedAt:timestamp,note});
 for(const value of [issue('unhandled'),issue('old-stale','stale'),issue('human-confirmed','confirmed','人工认为需要解题过程'),issue('human-resolved','resolved','保留已处理结论'),issue('human-note','open','人工已核对过'),{...issue('ai-evidence'),feedbackIds:['context']},issue('reverse-ai')])store.put('quality_issues',value.id,value);
 for(const [id,qualityIssueId]of [['context','ai-evidence'],['reverse-context','reverse-ai']])store.put('question_feedback',id,{id,origin:'quality',qualityIssueId,questionId:question.id,questionTitle:question.title,kind:'other',description:'旧AI分析证据',status:'pending',baseUpdatedAt:'',contentFingerprint:feedbackFingerprint({question}),createdAt:timestamp,updatedAt:timestamp,note:''});
 store.put('quality_issues','real-issue',{...issue('real-issue'),rule:'reference_placeholder',severity:'warning'});
 const beforeQuestions=store.all('questions'),beforeFeedback=store.all('question_feedback'),preserved=store.all<QualityIssue>('quality_issues').filter(row=>!['unhandled','old-stale'].includes(row.id));
 assert.equal(retireMissingExplanationIssues(store),2);assert.equal(retireMissingExplanationIssues(store),0);
 assert.deepEqual(store.all('quality_issues'),preserved);assert.deepEqual(store.all('questions'),beforeQuestions);assert.deepEqual(store.all('question_feedback'),beforeFeedback);
 const app=Fastify();t.after(()=>app.close());registerContentQualityRoutes(app,store);
 const overview=(await app.inject('/api/content-quality/overview')).json();assert.equal(overview.totalIssues,1);
 const listed=(await app.inject('/api/content-quality/issues?status=all')).json();assert.deepEqual(listed.items.map((row:any)=>row.id),['real-issue']);
 const deepLink=(await app.inject('/api/content-quality/issues?status=all&feedbackId=context')).json();assert.equal(deepLink.items[0].id,'ai-evidence');
 const detail=(await app.inject('/api/content-quality/issues/ai-evidence')).json();assert.equal(detail.feedbacks[0].description,'旧AI分析证据');
});
