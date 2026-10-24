import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Store} from '../../server/core/store.js';
import {parse,questionSchema} from '../../server/core/validation.js';
import {QuestionQueries} from '../../server/modules/questions/queries.js';

function fixture(store:Store){
 store.put('domains','computing',{id:'computing',name:'计算机',description:'',sortOrder:0});store.put('domains','chemistry',{id:'chemistry',name:'化学',description:'',sortOrder:1});
 for(const category of [{id:'root',domainId:'computing',parentId:null},{id:'child',domainId:'computing',parentId:'root'},{id:'grandchild',domainId:'computing',parentId:'child'},{id:'chemical',domainId:'chemistry',parentId:null}])store.put('categories',category.id,{...category,name:category.id,description:'',sortOrder:0});
 for(const id of ['concept','application','other'])store.put('tags',id,{id,name:id,kind:'custom',domainId:null,color:'#5264db',description:''});
 const ids=['Q10','Q2','Q02','q2','Q1','Q01','A-20','A-3','章节10','章节2','CAFÉ-2','Z9','Z10','Q100','Q20','Q003','X4','X5','X6','X7','X8','X9','X10','X11'];
 ids.forEach((id,index)=>{
  const q:any={...parse(questionSchema,{id,title:`知识 ${index} CAFÉ ΩΣ Русский İ`,type:index%3===0?'short_answer':index%3===1?'single_choice':'true_false',stemMarkdown:`普通题干 ${index}`,answerMarkdown:'参考 Greek ΟΣ 中文',explanationMarkdown:index%2?'实现细节':'应用示例',options:index%3===1?[{key:'A',text:'甲'},{key:'B',text:'乙'}]:[],correctAnswers:index%3===0?[]:index%3===1?['A']:['true'],categoryIds:index%4===0?['chemical']:index%4===1?['root']:index%4===2?['child']:['grandchild'],tagIds:index%3===0?['concept','application']:index%3===1?['concept']:['other'],status:index%5===0?'pending':index%7===0?'archived':'published',collection:index%2?'personal':'general',difficulty:index%4+1,depth:4-index%4,frequency:index%4}),id};
  if(index===23)delete q.frequency;
  store.put('questions',id,q);
  if(index%2)store.put('study',id,{questionId:id,favorite:index%3===0,mastery:2,notes:`笔记 ${id}`,nextReviewAt:index%4===1?'2020-01-01T00:00:00.000Z':'2099-01-01T00:00:00.000Z',lastReviewedAt:null,wrongCount:index%3});
 });
 store.put('papers','mixed',{id:'mixed',name:'混合集合',description:'',questionIds:ids.filter((_,index)=>index%2===0)});
 store.put('papers','empty',{id:'empty',name:'空集合',description:'',questionIds:[]});
}

/** Deliberately retain the former JS semantics as an independent oracle. */
function reference(store:Store,query:Record<string,any>){
 const rows=store.all('questions'),categories=store.all('categories'),states=new Map(store.all('study').map(s=>[s.questionId,s]));
 const allowed=new Set<string>();if(query.categoryId){allowed.add(query.categoryId);let changed=true;while(changed){changed=false;for(const c of categories)if(allowed.has(c.parentId)&&!allowed.has(c.id)){allowed.add(c.id);changed=true;}}}
 const domainCategories=new Set(categories.filter(c=>c.domainId===query.domainId).map(c=>c.id));
 const bank=query.paperId?new Set(store.require('papers',query.paperId).questionIds):null;
 const tags=Array.isArray(query.tagIds)?query.tagIds:String(query.tagIds||'').split(',').filter(Boolean);
 const truthy=(x:unknown)=>[true,'true','1'].includes(x as any);
 const search=String(query.search||'').toLowerCase().trim();
 return rows.filter(q=>{
  if(bank&&!bank.has(q.id))return false;
  if(query.status!=='all'&&q.status!==(query.status||'published'))return false;
  if(query.collection&&query.collection!=='all'&&q.collection!==query.collection)return false;
  if(query.type&&q.type!==query.type)return false;
  if(query.types?.length&&!query.types.includes(q.type))return false;
  if(query.difficulty&&q.difficulty!==Number(query.difficulty))return false;
  if(query.depth&&q.depth!==Number(query.depth))return false;
  if(query.frequency!==undefined&&q.frequency!==Number(query.frequency))return false;
  if(query.difficultyMin&&q.difficulty<Number(query.difficultyMin))return false;
  if(query.difficultyMax&&q.difficulty>Number(query.difficultyMax))return false;
  if(query.frequencyMin!==undefined&&q.frequency<Number(query.frequencyMin))return false;
  if(query.categoryId&&!q.categoryIds.some((id:string)=>allowed.has(id)))return false;
  if(query.domainId&&!q.categoryIds.some((id:string)=>domainCategories.has(id)))return false;
  if(tags.length&&!(query.tagMode==='any'?tags.some((id:string)=>q.tagIds.includes(id)):tags.every((id:string)=>q.tagIds.includes(id))))return false;
  if(search&&!`${q.id} ${q.title} ${q.stemMarkdown} ${q.answerMarkdown} ${q.explanationMarkdown}`.toLowerCase().includes(search))return false;
  const study=states.get(q.id)||{favorite:false,wrongCount:0,nextReviewAt:null};
  if(truthy(query.favorite)&&!study.favorite)return false;if(truthy(query.wrong)&&!study.wrongCount)return false;
  if(truthy(query.due)&&(!study.nextReviewAt||Date.parse(study.nextReviewAt)>Date.now()))return false;
  return true;
 }).sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
}

test('paged and complete question queries preserve former semantics across filters, Unicode search and natural ties',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 const queries:Record<string,any>[]=[{},...['all','published','pending','draft','archived'].map(status=>({status})),...['general','personal','all'].map(collection=>({collection})),...['root','child','grandchild','chemical'].map(categoryId=>({categoryId})),{domainId:'chemistry'},{domainId:'computing'},{paperId:'mixed'},{paperId:'empty'},{type:'single_choice'},{types:['short_answer','true_false']},{difficulty:'2'},{depth:3},{frequency:0},{frequency:'3'},{frequencyMin:0},{difficultyMin:2,difficultyMax:3},{favorite:true},{wrong:'1'},{due:'true'},{favorite:true,wrong:true,due:true},{tagIds:'concept,application'},{tagIds:['concept','other'],tagMode:'any'},...['cAFÉ','ωσ','РУССКИЙ','İ','i\u0307','οσ','中文','Q0','实现','%','_','missing','  应用  '].map(search=>({search}))];
 for(const collection of ['general','personal'])for(const tagMode of ['all','any'])for(const categoryId of ['root','chemical'])queries.push({status:'all',collection,tagMode,categoryId,tagIds:['concept','application'],difficultyMin:1,frequencyMin:0});
 for(const query of queries){
  const expected=reference(store,query).map(q=>q.id);
  assert.deepEqual(store.questions(query).map(q=>q.id),expected,JSON.stringify(query));assert.equal(store.questionCount(query),expected.length);
  for(const page of [1,2,20]){const result=store.questionPage({...query,page,pageSize:3});assert.equal(result.total,expected.length,JSON.stringify(query));assert.deepEqual(result.items.map(q=>q.id),expected.slice((page-1)*3,page*3),JSON.stringify({query,page}));}
 }
 const original=store.all('questions').sort((a,b)=>a.id.localeCompare(b.id,undefined,{numeric:true}));
 assert.deepEqual(store.questions({status:'all'}).map(q=>q.id),original.map(q=>q.id));
});

test('question page bounds JSON decoding and obtains study with a join rather than per-question calls',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 store.all=()=>{throw new Error('no full-table body decoding');};store.study=()=>{throw new Error('no per-question study lookup');};
 const page=store.questionPage({page:1,pageSize:2});assert.equal(page.items.length,2);assert.ok(page.total>2);assert.ok(page.items.every(q=>q.study?.questionId===q.id));
 const count=store.questionCount();assert.equal(count,page.total);
});

test('natural ordering refreshes after local insert/delete, survives rollback, and keeps metadata-only edits stable',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 const before=store.questions({status:'all'}).map(q=>q.id);
 const existing=store.require('questions','Q2');store.put('questions','Q2',{...existing,title:'更新后的标题'});assert.deepEqual(store.questions({status:'all'}).map(q=>q.id),before);
 assert.throws(()=>store.transaction(()=>{store.put('questions','Q0',{...existing,id:'Q0'});assert.equal(store.questions({status:'all'})[0]?.id==='Q0',false);throw new Error('rollback');}),/rollback/);
 assert.deepEqual(store.questions({status:'all'}).map(q=>q.id),before);
 store.put('questions','Q3',{...existing,id:'Q3'});assert.deepEqual(store.questions({status:'all'}).map(q=>q.id),reference(store,{status:'all'}).map(q=>q.id));store.remove('questions','Q3');assert.deepEqual(store.questions({status:'all'}).map(q=>q.id),before);
});

test('a live connection sees natural-order changes committed by another database connection',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'question-query-test-')),path=join(dir,'bank.sqlite');const first=new Store(path),second=new Store(path);
 t.after(async()=>{first.db.close();second.db.close();assert.equal(dirname(resolve(dir)),resolve(tmpdir()));assert.ok(basename(dir).startsWith('question-query-test-'));await rm(dir,{recursive:true,force:true});});
 fixture(first);const query={status:'all',page:1,pageSize:200};assert.equal(first.questionPage(query).total,24);
 second.put('questions','Q0',{...second.require('questions','Q2'),id:'Q0'});assert.deepEqual(first.questionPage(query).items.map(q=>q.id),reference(first,query).map(q=>q.id));
 second.put('questions','Q0',{...second.require('questions','Q0'),title:'External ΣΩ projection refresh',collection:'general',status:'published'});
 assert.deepEqual(first.questionPage({search:'external σω'}).items.map(q=>q.id),['Q0']);
 assert.equal(first.questionPage({search:'external σω',collection:'personal'}).total,0);
 second.remove('questions','Q1');assert.deepEqual(first.questionPage(query).items.map(q=>q.id),reference(first,query).map(q=>q.id));
});

test('missing and null legacy scalars retain distinct equality, range and interpolated-search semantics',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 const missing:any={...store.require('questions','Q2')};delete missing.difficulty;delete missing.answerMarkdown;store.put('questions',missing.id,missing);
 const nullable={...store.require('questions','Q1'),difficulty:null,frequency:null,answerMarkdown:null};store.put('questions',nullable.id,nullable);
 store.put('study','Q2',{questionId:'Q2',favorite:false,wrongCount:1,notes:'',nextReviewAt:'old-invalid-date'});
 for(const filter of [{difficultyMin:2},{difficultyMax:1},{frequencyMin:0},{frequencyMin:1},{frequency:0},{search:'undefined'},{search:'null'},{due:true}]){
  const query={...filter,status:'all'},expected=reference(store,query).map(q=>q.id);
  assert.deepEqual(store.questions(query).map(q=>q.id),expected,JSON.stringify(query));
  assert.deepEqual(store.questionPage({...query,page:1,pageSize:200}).items.map(q=>q.id),expected);
 }
});

test('search, taxonomy and bank values remain bound literals including SQL syntax, percent and underscore',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 const unsafe="x' OR 1=1; DROP TABLE questions; -- %_",id='literal-1';
 store.put('tags',unsafe,{id:unsafe,name:'字面标签',kind:'custom',domainId:null,color:'#5264db',description:''});
 store.put('categories',unsafe,{id:unsafe,name:'字面分类',domainId:'computing',parentId:null,description:'',sortOrder:0});
 store.put('questions',id,{...store.require('questions','Q2'),id,title:`Literal ${unsafe}`,categoryIds:[unsafe],tagIds:[unsafe]});
 store.put('papers',unsafe,{id:unsafe,name:'字面题库',description:'',questionIds:[id]});
 const observed:{sql:string;parameters:readonly unknown[]}[]=[];
 const original=store.database.all.bind(store.database);
 store.database.all=((builder:any)=>{const compiled=builder.compile();observed.push(compiled);return original(builder);}) as typeof store.database.all;
 for(const filter of [{search:unsafe},{tagIds:[unsafe]},{categoryId:unsafe},{paperId:unsafe}]){
  const result=store.questionPage({...filter,pageSize:100});assert.deepEqual(result.items.map(q=>q.id),[id]);assert.equal(result.total,1);
 }
 assert.equal(store.questionCount({status:'all'}),25);
 assert.ok(observed.length>=4);assert.ok(observed.every(query=>!query.sql.includes(unsafe)));
 assert.ok(observed.some(query=>query.parameters.some(value=>String(value).includes(unsafe))));
 for(const query of [{search:'%_'},{search:"' OR 1=1"},{search:'%absent%'},{search:'_absent_'}])assert.deepEqual(store.questions(query).map(q=>q.id),reference(store,query).map(q=>q.id));
});

test('count uses a covering status index and page execution returns only bounded question bodies',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 const repository=new QuestionQueries(store.database);
 const plan=repository.explain({collection:'personal',type:'single_choice'},{tags:[]}) as {detail:string}[];
 assert.ok(plan.some(row=>/SEARCH q USING (?:COVERING )?INDEX question_read_status_collection_type_idx/.test(row.detail)),JSON.stringify(plan));
 // Warm the disposable ID cache before observing page entity reads.
 store.questionPage({pageSize:1});
 const returned:{data:string|null}[][]=[];const original=store.database.all.bind(store.database);
 store.database.all=((builder:any)=>{const rows=original(builder);returned.push(rows as {data:string|null}[]);return rows;}) as typeof store.database.all;
 const result=store.questionPage({status:'all',page:2,pageSize:3});
 assert.equal(result.total,24);assert.equal(result.items.length,3);
 assert.equal(returned.flat().filter(row=>typeof row.data==='string').length,3);
 assert.deepEqual(store.questionPage({paperId:'empty',page:7,pageSize:3}),{items:[],total:0,page:7,pageSize:3});
 const outOfRange=store.questionPage({status:'all',page:100,pageSize:3});assert.equal(outOfRange.total,24);assert.deepEqual(outOfRange.items,[]);
});

test('derived selection and search refresh after body or metadata edits and a read inside a rolled-back write',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 const id='Q2',initial={...store.require('questions',id),title:'独立投影 beforeword',stemMarkdown:'OnlyBeforeStem',status:'published',collection:'personal',tagIds:['concept']};
 store.put('questions',id,initial);
 assert.deepEqual(store.questionPage({search:'OnlyBeforeStem'}).items.map(q=>q.id),[id]);
 const changed={...initial,title:'独立投影 afterword',stemMarkdown:'OnlyAfterStem',collection:'general',tagIds:['application']};
 store.put('questions',id,changed);
 assert.equal(store.questionCount({search:'OnlyBeforeStem'}),0);
 assert.deepEqual(store.questions({search:'OnlyAfterStem',collection:'general',tagIds:['application']}).map(q=>q.id),[id]);
 assert.equal(store.questionCount({search:'OnlyAfterStem',collection:'personal'}),0);
 assert.throws(()=>store.transaction(()=>{
  store.put('questions',id,{...changed,stemMarkdown:'TemporaryTransactionStem',collection:'personal'});
  assert.deepEqual(store.questionPage({search:'TemporaryTransactionStem',collection:'personal'}).items.map(q=>q.id),[id]);
  throw new Error('abort projection refresh');
 }),/abort projection refresh/);
 assert.deepEqual(store.questionPage({search:'OnlyAfterStem',collection:'general'}).items.map(q=>q.id),[id]);
 assert.equal(store.questionCount({search:'TemporaryTransactionStem'}),0);
 store.remove('questions',id);assert.equal(store.questionCount({search:'OnlyAfterStem'}),0);
});

test('batch metadata keeps input order and all review states using one bound ID set without decoding question bodies',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());fixture(store);
 const unsafe="x' OR 1=1; DROP TABLE questions; --", q=store.require('questions','Q2');
 store.put('questions',unsafe,{...q,id:unsafe,title:'literal-only'});
 // Refresh disposable metadata before observing this read-only lookup.
 store.questionCount({status:'all'});
 const observed:{sql:string;parameters:readonly unknown[];data:unknown[]}[]=[],original=store.database.all.bind(store.database);
 store.database.all=((builder:any)=>{const compiled=builder.compile(),rows=original(builder);observed.push({...compiled,data:rows});return rows;}) as typeof store.database.all;
 store.question=()=>{throw new Error('must not query each source body');};
 store.all=()=>{throw new Error('must not decode full question table');};
 const ids=['A-3','missing-first','Q10',unsafe,'Q2','missing-last'],result=store.questionMetadataByIds(ids);
 assert.deepEqual(result.items.map(item=>item.id),['A-3','Q10',unsafe,'Q2']);
 assert.deepEqual(result.items.map(item=>item.status),['archived','pending','published','published']);
 assert.deepEqual(result.missingIds,['missing-first','missing-last']);
 assert.ok(result.items.every(item=>Object.keys(item).sort().join(',')==='id,status,title,type'));
 const queries=observed.filter(query=>query.sql.includes('from "question_read_model"'));
 assert.equal(queries.length,1);assert.ok(queries[0]!.parameters.some(value=>typeof value==='string'&&value.includes(unsafe)));
 assert.ok(observed.every(query=>!query.sql.includes(unsafe)&&!query.sql.includes('from "questions"')));
 assert.ok(!JSON.stringify(observed.flatMap(query=>query.data)).includes('answerMarkdown'));
});
