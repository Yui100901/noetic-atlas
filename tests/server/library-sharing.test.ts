import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { buildApp } from '../../server/index.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/routes.js';
import { normalizeDocument } from '../../server/modules/library/routes.js';
import { parse, questionSchema } from '../../server/core/validation.js';
import { buildPaper, expandPaper } from '../../server/modules/practice/service.js';
import type { Question } from '../../shared/models/types.js';
import { decodeAssetBase64 } from '../../server/modules/assets/schema.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
const stamp='2026-10-21T00:00:00.000Z';
function fixture(t:test.TestContext){const store=new Store(':memory:');t.after(()=>store.db.close());return store;}
function seed(store:Store){store.put('domains','computer',{id:'computer',name:'计算机',description:'',sortOrder:0});store.put('categories','backend',{id:'backend',name:'后端',domainId:'computer',parentId:null,description:'',sortOrder:0});store.put('categories','go',{id:'go',name:'Go',domainId:'computer',parentId:'backend',description:'',sortOrder:0});store.put('tags','concurrency',{id:'concurrency',name:'并发',domainId:'computer',kind:'topic',color:'#5264db',description:''});store.put('assets','diagram',{id:'diagram',filename:'图.png',mimeType:'image/png',dataBase64:png,sizeBytes:decodeAssetBase64(png).length,width:1,height:1,createdAt:stamp});const q={...parse(questionSchema,{id:'go-question',title:'看图说明并发边界',type:'short_answer',stemMarkdown:'![图](/api/assets/diagram/content)',answerMarkdown:'共享状态需要同步。',categoryIds:['go'],tagIds:['concurrency'],status:'published',sourceDocument:'C:/private/resume.md'}),id:'go-question',createdAt:stamp,updatedAt:stamp} as Question;store.put('questions',q.id,q);store.put('study',q.id,{questionId:q.id,notes:'私人笔记和秘密',favorite:true,mastery:1});return q;}
test('library normalizes old subject taxonomy on reads without rewriting stored documents',t=>{const store=fixture(t);seed(store);const document={id:'old',title:'旧资料',kind:'PDF资料',bodyMarkdown:'# 资料',collection:'general' as const,categoryIds:['go'],tagIds:['concurrency'],sourcePath:null};store.put('documents','old',document);const normalized=normalizeDocument(store,document);assert.deepEqual(normalized.domainIds,['computer']);assert.equal(normalized.author,'');assert.equal(normalized.kind,'PDF资料');assert.deepEqual(store.get('documents','old'),document);});
test('library supports cross-domain books, metadata and independent subject/type/file filters',async t=>{const app=await buildApp({databasePath:':memory:',seedPath:'test-results/no-library-seed.json',staticRoot:'test-results/no-library-web'});t.after(()=>app.close());const json=(r:any,status=200)=>{assert.equal(r.statusCode,status,JSON.stringify(r.json()));return r.json();};for(const did of ['computer','language'])json(await app.inject({method:'POST',url:'/api/domains',payload:{id:did,name:did}}),201);json(await app.inject({method:'POST',url:'/api/categories',payload:{id:'root',name:'计算机基础',domainId:'computer'}}),201);json(await app.inject({method:'POST',url:'/api/categories',payload:{id:'leaf',name:'操作系统',domainId:'computer',parentId:'root'}}),201);const document=json(await app.inject({method:'POST',url:'/api/documents',payload:{id:'book',title:'系统原理',kind:'书籍',bodyMarkdown:'知识',domainIds:['computer','language'],categoryIds:['leaf'],author:'作者甲',publisher:'出版社乙',publishedYear:'2025 / 第3版',description:'参考书'}}),201);assert.deepEqual(document.domainIds,['computer','language']);for(const query of ['domainId=language&kind=书籍','categoryId=root','search=作者甲','format=markdown'])assert.equal(json(await app.inject('/api/documents?'+query)).length,1);assert.equal(json(await app.inject('/api/documents?kind=学习笔记')).length,0);json(await app.inject({method:'DELETE',url:'/api/domains/language'}),409);json(await app.inject({method:'PUT',url:'/api/documents/book',payload:{...document,author:'新作者'}}));json(await app.inject({method:'PUT',url:'/api/documents/book',payload:document}),409);});
test('sharing exports all taxonomy ancestors and binary assets while stripping private records and paths',t=>{const store=fixture(t);const q=seed(store);const data=exportShare(store,{kind:'questions',ids:[q.id]});assert.deepEqual(new Set(data.categories.map(c=>c.id)),new Set(['go','backend']));assert.equal(data.domains[0]!.id,'computer');assert.equal(data.tags[0]!.id,'concurrency');assert.equal(data.assets[0]!.dataBase64,png);assert.equal(data.questions[0]!.study,undefined);assert.equal(data.questions[0]!.sourceDocument,null);assert.equal(JSON.stringify(data).includes('私人笔记'),false);assert.equal('settings' in data,false);assert.equal('attempts' in data,false);assert.equal(exportShare(store,{kind:'questions',filters:{domainId:'computer',type:'',status:'',difficulty:'',frequency:'0',tagIds:['concurrency'],favorite:true}}).questions.length,1);assert.throws(()=>exportShare(store,{kind:'questions',filters:{domainId:{invalid:true}}}));});
test('sharing remaps an entire conflicting graph without changing local rows and reimports idempotently',t=>{const source=fixture(t);seed(source);const data=exportShare(source,{kind:'questions',ids:['go-question']});const target=fixture(t);target.put('domains','computer',{id:'computer',name:'既有其他领域',description:'',sortOrder:0});target.put('assets','diagram',{...data.assets[0],filename:'本地图.png'});target.put('questions','go-question',{...data.questions[0],title:'本地不同题目',categoryIds:[],tagIds:[],stemMarkdown:'本地题干',status:'published'});const original=JSON.stringify(target.get('questions','go-question'));const plan=planShareImport(target,data);assert.equal(plan.preview.counts.questions!.remapped,1);assert.equal(target.all('categories').length,0);const imported=importShare(target,data,plan.preview.fingerprint);const qid=imported.questions[0]!.id;const question=target.get<Question>('questions',qid)!;assert.notEqual(qid,'go-question');assert.equal(question.status,'pending');assert.equal(JSON.stringify(target.get('questions','go-question')),original);const cid=question.categoryIds[0]!;const domain=target.get<any>('categories',cid)!.domainId;assert.notEqual(domain,'computer');const aid=[...question.stemMarkdown.matchAll(/\/api\/assets\/([^/]+)\/content/g)][0]![1]!;assert.notEqual(aid,'diagram');assert.equal(target.get<any>('assets',aid).dataBase64,png);const before={questions:target.all('questions').length,assets:target.all('assets').length,domains:target.all('domains').length};const repeated=importShare(target,data);assert.equal(repeated.counts.questions!.added,0);assert.equal(repeated.counts.questions!.reused,1);assert.deepEqual({questions:target.all('questions').length,assets:target.all('assets').length,domains:target.all('domains').length},before);});
test('sharing reuses identical reviewed content without downgrading local review state',t=>{const store=fixture(t);seed(store);const data=exportShare(store,{kind:'questions',ids:['go-question']});const preview=planShareImport(store,data).preview;assert.equal(preview.counts.questions!.reused,1);const result=importShare(store,data);assert.equal(result.questions[0]!.status,'reused');assert.equal(store.get<Question>('questions','go-question')!.status,'published');});
test('sharing preview rejects malformed dependency/media graphs and imports leave no partial rows',t=>{const source=fixture(t);seed(source);const original=exportShare(source,{kind:'questions',ids:['go-question']});const target=fixture(t);for(const change of [(d:any)=>{d.categories=d.categories.filter((c:any)=>c.id!=='backend');},(d:any)=>{d.assets[0].sizeBytes=1;},(d:any)=>{d.questions[0].tagIds=['missing'];},(d:any)=>{d.questions[0].stemMarkdown='![missing](/api/assets/missing/content)';},(d:any)=>{d.domains.push(d.domains[0]);}]){const data=structuredClone(original);change(data);assert.throws(()=>planShareImport(target,data));assert.throws(()=>importShare(target,data));assert.equal(target.all('domains').length,0);assert.equal(target.all('questions').length,0);assert.equal(target.all('assets').length,0);}});
test('shared paper keeps frozen questions and scores, imports pending and archives until user review',t=>{const source=fixture(t);const q=seed(source);source.put('papers','original-paper',buildPaper(source,{id:'original-paper',title:'原卷',description:'分值快照',mode:'manual',organization:'domain',domainId:'computer',questionIds:[q.id],scoring:{enabled:true,totalPoints:8,questionPoints:{[q.id]:8}}}));source.put('questions',q.id,{...q,stemMarkdown:'后来改变的题干'});const data=exportShare(source,{kind:'paper',id:'original-paper'});assert.equal(data.questions[0]!.stemMarkdown,q.stemMarkdown);const target=fixture(t);importShare(target,data);const paper=target.get<any>('papers','original-paper');assert.equal(paper.archived,true);assert.equal(paper.scoring.totalPoints,8);assert.equal(paper.scoring.questionPoints[q.id],8);assert.equal(paper.snapshot[0].stemMarkdown,q.stemMarkdown);assert.equal(paper.organization,'domain');assert.equal(paper.domainId,'computer');assert.equal(target.get<Question>('questions',q.id)!.status,'pending');assert.equal(target.all('attempts').length,0);});
test('sharing detects a changed local graph after preview and preserves identical duplicate questions on papers',t=>{const source=fixture(t);const q=seed(source);const duplicate={...q,id:'same-content'};source.put('questions',duplicate.id,duplicate);const paper=buildPaper(source,{id:'dupes',title:'相同题干两题',description:'',mode:'manual',questionIds:[q.id,duplicate.id]});source.put('papers',paper.id,paper);const data=exportShare(source,{kind:'paper',id:paper.id});const target=fixture(t);const preview=planShareImport(target,data).preview;target.put('domains','changed',{id:'changed',name:'变化',description:'',sortOrder:0});assert.throws(()=>importShare(target,data,preview.fingerprint));assert.equal(target.all('questions').length,0);importShare(target,data);assert.equal(target.all('questions').length,2);assert.equal(new Set(target.get<any>('papers','dupes').questionIds).size,2);});
test('shared grouped questions remap parent scoring keys and preserve objective/subjective child weights',t=>{const source=fixture(t);const group={...parse(questionSchema,{id:'group',title:'阅读程序',type:'group',stemMarkdown:'共同程序材料',parts:[{id:'choice',title:'选择输出',type:'single_choice',stemMarkdown:'输出为何',options:[{key:'A',text:'1'},{key:'B',text:'2'}],correctAnswers:['A'],weight:1},{id:'explain',title:'说明原因',type:'short_answer',stemMarkdown:'说明边界',answerMarkdown:'参考答案',weight:2}],status:'published'}),id:'group'}as Question;source.put('questions',group.id,group);const paper=buildPaper(source,{id:'group-paper',title:'组合题分享',description:'',mode:'manual',questionIds:[group.id],scoring:{enabled:true,totalPoints:7,questionPoints:{group:7}}});source.put('papers',paper.id,paper);const target=fixture(t);target.put('questions','group',{...group,title:'本地其他材料'});const result=importShare(target,exportShare(source,{kind:'paper',id:paper.id}));const qid=result.questions[0]!.id;assert.notEqual(qid,'group');const imported=target.get<any>('papers','group-paper');assert.equal(imported.scoring.questionPoints[qid],7);const expanded=expandPaper(imported);assert.deepEqual(expanded.questions.map(q=>q.id),[`${qid}::choice`,`${qid}::explain`]);assert.equal(expanded.scoring.questionPoints[`${qid}::choice`],2.33);assert.equal(expanded.scoring.questionPoints[`${qid}::explain`],4.67);assert.equal(expanded.questions[0]!.correctAnswers[0],'A');});


test('reimporting a paper after review or restore preserves the recipient lifecycle without duplicate papers',t=>{
  const source=fixture(t),original=seed(source);
  const sourcePaper=buildPaper(source,{id:'review-lifecycle',title:'复习卷',description:'',mode:'manual',questionIds:[original.id]});
  source.put('papers',sourcePaper.id,sourcePaper);
  const data=exportShare(source,{kind:'paper',id:sourcePaper.id}),target=fixture(t);
  importShare(target,data);
  assert.equal(target.get<any>('papers',sourcePaper.id).archived,true);
  target.put('questions',original.id,{...target.get('questions',original.id),status:'published'});
  const local=target.get<any>('papers',sourcePaper.id);
  target.put('papers',sourcePaper.id,{...local,version:7,snapshot:local.snapshot.map((q:Question)=>({...q,status:'published'}))});
  const reviewed=importShare(target,data);
  assert.equal(reviewed.counts.questions!.reused,1);
  assert.equal(reviewed.counts.papers!.reused,1);
  assert.equal(reviewed.counts.papers!.added,0);
  assert.equal(target.all('papers').length,1);
  assert.equal(target.get<any>('papers',sourcePaper.id).archived,true);
  assert.equal(target.get<any>('papers',sourcePaper.id).version,7);
  target.put('papers',sourcePaper.id,{...target.get<any>('papers',sourcePaper.id),archived:false,version:8});
  data.papers[0]!.archived=true;
  const restored=importShare(target,data);
  assert.equal(restored.counts.papers!.added,0);
  assert.equal(target.get<any>('papers',sourcePaper.id).archived,false);
  assert.equal(target.get<Question>('questions',original.id)!.status,'published');

  // An intentionally archived source stays archived on a first import even
  // when all its questions already exist locally and have passed review.
  const fresh=fixture(t);
  importShare(fresh,{...data,papers:[]});
  fresh.put('questions',original.id,{...fresh.get('questions',original.id),status:'published'});
  importShare(fresh,data);
  assert.equal(fresh.get<any>('papers',sourcePaper.id).archived,true);
});

test('semantic category and tag aliases collapse to unique valid references on questions and paper snapshots',t=>{
  const source=fixture(t),original=seed(source);
  source.put('categories','go-alias',{...source.get('categories','go'),id:'go-alias',sortOrder:99});
  source.put('tags','concurrency-alias',{...source.get('tags','concurrency'),id:'concurrency-alias'});
  source.put('questions',original.id,{...original,categoryIds:['go','go-alias'],tagIds:['concurrency','concurrency-alias']});
  const paper=buildPaper(source,{id:'aliases',title:'别名引用',description:'',mode:'manual',questionIds:[original.id]});
  source.put('papers',paper.id,paper);
  const data=exportShare(source,{kind:'paper',id:paper.id}),target=fixture(t);
  importShare(target,data);
  for(const q of [target.get<Question>('questions',original.id)!,target.get<any>('papers',paper.id).snapshot[0]]){
    assert.deepEqual(q.categoryIds,['go']);
    assert.deepEqual(q.tagIds,['concurrency']);
    assert.equal(questionSchema.safeParse(q).success,true);
  }
  assert.equal(importShare(target,data).counts.questions!.added,0);
});

test('cyclic related-question links and frozen papers follow collision maps and reimport idempotently',t=>{
  const source=fixture(t),original=seed(source),neighbor='关联词';
  const first={...original,explanationMarkdown:'[关联词](#/questions/'+encodeURIComponent(neighbor)+'?answer=1) [外部页面](https://example.test/#/questions/'+neighbor+')'};
  const second={...original,id:neighbor,title:'关联词题目',answerMarkdown:'另一个含义',explanationMarkdown:'[返回](#/questions/'+original.id+')'};
  source.put('questions',first.id,first);source.put('questions',second.id,second);
  const paper=buildPaper(source,{id:'linked',title:'关联题',description:'',mode:'manual',questionIds:[first.id,second.id]});
  source.put('papers',paper.id,paper);
  const data=exportShare(source,{kind:'paper',id:paper.id}),target=fixture(t);
  target.put('questions',first.id,{...first,title:'本地其他题目',stemMarkdown:'本地题干',categoryIds:[],tagIds:[]});
  target.put('questions',second.id,{...second,title:'本地其他关联词',stemMarkdown:'本地词条',categoryIds:[],tagIds:[]});
  const result=importShare(target,data),firstId=result.questions[0]!.id,secondId=result.questions[1]!.id;
  assert.notEqual(firstId,first.id);assert.notEqual(secondId,second.id);
  const importedFirst=target.get<Question>('questions',firstId)!,importedSecond=target.get<Question>('questions',secondId)!;
  assert.ok(importedFirst.explanationMarkdown.includes('#/questions/'+encodeURIComponent(secondId)+'?answer=1'));
  assert.ok(importedFirst.explanationMarkdown.includes('https://example.test/#/questions/'+neighbor));
  assert.ok(importedSecond.explanationMarkdown.includes('#/questions/'+encodeURIComponent(firstId)));
  assert.equal(target.get<any>('papers',paper.id).snapshot[0].explanationMarkdown,importedFirst.explanationMarkdown);
  target.put('questions',firstId,{...importedFirst,status:'published'});
  const again=importShare(target,data);
  assert.equal(again.counts.questions!.added,0);assert.equal(again.counts.questions!.reused,2);
  assert.equal(again.counts.papers!.added,0);assert.equal(target.all('papers').length,1);
  assert.equal(target.get<Question>('questions',firstId)!.status,'published');
  assert.equal(target.get<Question>('questions',first.id)!.title,'本地其他题目');
});

test('link graph matching does not reuse a same-text card whose deeper reference points to different content',t=>{
  const source=fixture(t),original=seed(source);
  const a={...original,id:'a',title:'节点A',explanationMarkdown:'[next](#/questions/b)'};
  const b={...original,id:'b',title:'节点B',explanationMarkdown:'[next](#/questions/a)'};
  source.put('questions',a.id,a);source.put('questions',b.id,b);
  const data=exportShare(source,{kind:'questions',ids:[a.id,b.id]}),target=fixture(t);
  // Both root templates and immediate neighbor templates are identical. The
  // mismatch is one edge deeper, so masking URL IDs or hashing one hop fails.
  target.put('questions','a',{...a,explanationMarkdown:'[next](#/questions/wrong-b)'});
  target.put('questions','wrong-b',{...b,id:'wrong-b',explanationMarkdown:'[next](#/questions/unrelated)'});
  target.put('questions','unrelated',{...a,id:'unrelated',title:'不同语义'});
  const first=importShare(target,data),aId=first.questions[0]!.id,bId=first.questions[1]!.id;
  assert.notEqual(aId,'a');assert.notEqual(bId,'wrong-b');
  assert.ok(target.get<Question>('questions',aId)!.explanationMarkdown.includes('#/questions/'+encodeURIComponent(bId)));
  const again=importShare(target,data);
  assert.equal(again.counts.questions!.added,0);assert.equal(again.counts.questions!.reused,2);
  assert.deepEqual(again.questions.map(q=>q.id),[aId,bId]);
});

test('out-of-package related details become explicit searches while external links remain unchanged',t=>{
  const source=fixture(t),original=seed(source);
  source.put('questions',original.id,{...original,explanationMarkdown:'[下一词](#/questions/not-in-this-part) [外部](https://example.test/#/questions/not-in-this-part)'});
  const target=fixture(t);
  target.put('questions','not-in-this-part',{...original,id:'not-in-this-part',title:'本地不同题',categoryIds:[],tagIds:[]});
  const data=exportShare(source,{kind:'questions',ids:[original.id]}),result=importShare(target,data);
  const q=target.get<Question>('questions',result.questions[0]!.id)!;
  assert.ok(q.explanationMarkdown.includes('[下一词](#/questions?search=not-in-this-part)'));
  assert.ok(q.explanationMarkdown.includes('https://example.test/#/questions/not-in-this-part'));
  assert.ok(result.warnings.some(w=>w.includes('题号搜索')));
  assert.equal(importShare(target,data).counts.questions!.added,0);
});

