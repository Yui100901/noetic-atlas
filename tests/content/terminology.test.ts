import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTermPack,lexicalReferences} from '../../scripts/content/terminology/term-builder.mjs';
import {validatePack,asShare} from '../../scripts/content/manage.js';
import {buildApp} from '../../server/index.js';

const options=()=>({packId:'terms-fixture',title:'术语测试',domainIds:['computer-science','english'],idPrefix:'TERM-FIX-',categoryPrefix:'term-fix',groups:[{id:'language',name:'术语测试',description:'测试',rows:[{key:'dependency',term:'依赖',english:'Dependency Injection',aliases:['DI'],definition:'这是测试专用定义，用于说明术语卡包含英文全称和缩写，并验证每条概念都通过相同的分类与迁移约束。',example:'在构造函数中传入依赖。',distinction:'词义参考与专业定义分开组织。',pitfall:'有英语词义不代表技术定义完整。',followup:'迁移后如何查询词头？',followupAnswer:'按名称查找，不依赖源库题号。',sources:[{label:'测试来源',url:'https://example.org/reference'}]}]}]});
const word=(id:string,title:string,status='published',categoryIds=['terms-root-english'])=>({...JSON.parse(readFileSync('tests/fixtures/driving-content.json','utf8')).questions[0],id,title,stemMarkdown:'Recall the word.',answerMarkdown:'ordinary word meaning',explanationMarkdown:'word usage',type:'short_answer',options:[],correctAnswers:[],categoryIds,tagIds:['method-terminology'],status});

test('term generation keeps bilingual heads, true abbreviations and portable exact lexical references',()=>{
  const words=new Map([['dependency','dependency'],['injection','injection'],['the','the']]);
  assert.deepEqual(lexicalReferences('Dependency Injection',words).map(r=>r.word),['dependency','injection']);
  assert.deepEqual(lexicalReferences('Supervised Learning',new Map([['learn','learn']])).map(r=>({word:r.word,original:r.original})),[{word:'learn',original:'learning'}]);
  const {pack}=createTermPack(options(),words),normalized=validatePack(pack),q=normalized.questions[0];
  assert.match(q.title,/Dependency Injection.*DI/);assert.match(q.explanationMarkdown,/#\/vocabulary\/dependency/);
  assert.ok(q.tagIds.includes('method-terminology'));assert.ok(q.tagIds.includes('method-reference'));assert.equal(q.status,'pending');
  const share=asShare(normalized,'Single term');assert.equal(share.questions.length,1);assert.match(share.questions[0].explanationMarkdown,/#\/vocabulary\/injection/);
  const duplicate=options();duplicate.groups[0].rows.push(structuredClone(duplicate.groups[0].rows[0]));assert.throws(()=>createTermPack(duplicate,words),/Duplicate terminology/);
});

test('lexical lookup resolves remapped IDs by exact English head, preserves status, and provides a missing state',async()=>{
  const app=await buildApp({databasePath:':memory:',seedPath:'test-results/no-terminology-seed.json'});
  try{
    const {pack}=createTermPack(options());
    const data={...pack,domains:[...pack.domains,{id:'remapped-english-domain',name:'英语',description:'被分享导入重映射的领域',sortOrder:11}],categories:[...pack.categories,{id:'remapped-english-category',domainId:'remapped-english-domain',name:'单词',description:'',sortOrder:0,parentId:null}],questions:[...pack.questions,word('custom-word-id','dependency'),word('pending-variant','dependency','pending'),word('not-the-head','dependency tree'),word('other-domain','dependency','published',['term-fix-language']),word('remapped-learn','learn','published',['remapped-english-category'])]};
    const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
    const result=await app.inject({method:'GET',url:'/api/vocabulary?word='+encodeURIComponent(' Ｄｅｐｅｎｄｅｎｃｙ ')});assert.equal(result.statusCode,200,result.body);
    assert.deepEqual(result.json().matches,[{id:'custom-word-id',title:'dependency',status:'published'},{id:'pending-variant',title:'dependency',status:'pending'}]);
    assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['x-content-type-options'],'nosniff');
    assert.deepEqual((await app.inject('/api/vocabulary?word=missing')).json().matches,[]);
    assert.equal((await app.inject('/api/vocabulary?word=learn')).json().matches[0].id,'remapped-learn');
    for(const [head,lookup]of [['CAFÉ','cafe\u0301'],['Ｄｅｐｅｎｄｅｎｃｙ','dependency']]){
      const single={...pack,questions:[word('unicode-head',head)],questionBanks:[]};const unicodeApp=await buildApp({databasePath:':memory:',seedPath:'test-results/no-terminology-seed.json'});
      try{assert.equal((await unicodeApp.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:single}})).statusCode,200);assert.equal((await unicodeApp.inject('/api/vocabulary?word='+encodeURIComponent(lookup))).json().matches[0].id,'unicode-head');}finally{await unicodeApp.close();}
    }
    assert.deepEqual((await app.inject('/api/vocabulary?word='+encodeURIComponent("' OR 1=1--"))).json().matches,[]);
    assert.equal((await app.inject('/api/vocabulary')).statusCode,400);
    const question=(await app.inject('/api/questions/custom-word-id')).json();assert.equal(question.status,'published');
    const docs=(await app.inject('/api/docs/json')).json();assert.ok(docs.paths['/api/vocabulary']);assert.ok(docs.paths['/api/vocabulary'].get.parameters.some((p:any)=>p.name==='word'));
    const paper=await app.inject({method:'POST',url:'/api/papers',payload:{title:'考试',mode:'manual',questionIds:['custom-word-id'],scoring:{enabled:false}}});assert.equal(paper.statusCode,201,paper.body);
    const started=await app.inject({method:'POST',url:`/api/papers/${paper.json().id}/attempts`,payload:{mode:'exam',durationMinutes:1}});assert.equal(started.statusCode,201,started.body);
    assert.equal((await app.inject('/api/vocabulary?word=dependency')).statusCode,409);
  }finally{await app.close();}
});
