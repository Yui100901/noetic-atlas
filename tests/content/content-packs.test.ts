import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePack, validatePackSet, assertImportCompatible, wordlistPapers, asShare } from '../../scripts/content/manage.js';
import { Store } from '../../server/core/store.js';
import { importData } from '../../server/modules/transfer/migration.js';
import { planShareImport, importShare } from '../../server/modules/sharing/service.js';
import { materializeContentSets } from '../../scripts/content/question-sets.mjs';

const driving=()=>validatePack(JSON.parse(readFileSync('tests/fixtures/driving-content.json','utf8')));
function vocabulary(count:number) {
  const base=driving();
  const questions=Array.from({length:count},(_,i)=>({...base.questions[0],id:`EN-V-${String(i+1).padStart(6,'0')}`,title:`word-${i+1}`,stemMarkdown:`Recall word-${i+1}.`,answerMarkdown:`Definition ${i+1}`,explanationMarkdown:`Usage ${i+1}`,categoryIds:['en-vocabulary'],tagIds:['en-word'],type:'short_answer',options:[],correctAnswers:[]}));
  return validatePack(materializeContentSets({...base,papers:[],questionBanks:[],domains:[{id:'english',name:'英语',description:'Fixture domain',sortOrder:1}],categories:[{id:'en-vocabulary',domainId:'english',parentId:null,name:'单词',description:'Fixture category',sortOrder:0}],tags:[{id:'en-word',domainId:'english',name:'词汇',color:'#123456',description:'Fixture tag',kind:'topic'}],questions,assets:[],questionSets:[{id:'en-fixture-bank',name:'词汇全集',description:'Fixture bank',questionIds:questions.map(q=>q.id)}]}));
}

test('content packs remain pending and image-based driving questions are independently importable',()=>{
  const pack=driving(),store=new Store(':memory:');
  try {
    assert.equal(pack.questions.length,3);
    assert.equal(pack.assets.length,1);
    const share=asShare(pack,'驾驶理论扩展');
    const preview=planShareImport(store,share).preview;
    assert.equal(preview.counts.questions.added,pack.questions.length);
    importShare(store,share,preview.fingerprint);
    assert.equal(store.all<any>('questions').every(q=>q.status==='pending'),true);
    assert.equal(store.all('assets').length,1);
    for(const q of pack.questions.filter((q:any)=>q.tagIds.includes('drv-diagram'))){
      assert.ok(!q.stemMarkdown.includes(q.answerMarkdown));
      assert.ok(!q.title.startsWith('识别交通标志：'));
      assert.match(q.stemMarkdown,/\/api\/assets\/drv-sign-/);
    }
  }finally{store.db.close();}
});

test('vocabulary wordlists are unscored, archived pending review, and keep their own frozen content',()=>{
  const base=driving();
  const words=Array.from({length:205},(_,i)=>({...base.questions[0],id:`EN-V-${String(i).padStart(6,'0')}`,title:`word-${i}`,categoryIds:['en-vocabulary'],tagIds:['en-word'],type:'short_answer',options:[],correctAnswers:[]}));
  const pack=validatePack({...base,domains:[{id:'english',name:'英语',description:'',sortOrder:1}],categories:[{id:'en-vocabulary',domainId:'english',parentId:null,name:'单词',description:'',sortOrder:0}],tags:[{id:'en-word',domainId:'english',name:'词汇',color:'#123456',description:'',kind:'topic'}],questions:words,assets:[],questionBanks:[],papers:[]});
  const papers=wordlistPapers(pack);
  assert.deepEqual(papers.map(p=>p.questionCount),[100,100,5]);
  assert.ok(papers.every(p=>p.archived&&!p.scoring.enabled&&p.scoring.totalPoints===0&&p.domainId==='english'));
  const store=new Store(':memory:');
  try {importData(store,{...pack,papers});assert.equal(store.all('papers').length,3);assert.equal(store.get<any>('papers',papers[0].id).snapshot[0].title,'word-0');}
  finally{store.db.close();}
});

test('new-content validation rejects published or private records and broken cross-domain tags',()=>{
  for(const mutate of [(p:any)=>{p.questions[0].status='published';},(p:any)=>{p.questions[0].sourceDocument='private.md';},(p:any)=>{p.questions[0].tagIds=['missing'];},(p:any)=>{p.categories[0].parentId=p.categories[0].id;},(p:any)=>{p.settings={key:'private'};},(p:any)=>{p.documentDrafts=[{state:{bodyMarkdown:'私人草稿'}}];},(p:any)=>{p.questionDrafts=[{state:{form:{stemMarkdown:'私人题目草稿'}}}];},(p:any)=>{p.questionRevisions=[{content:{answerMarkdown:'私人修订内容'}}];}]){
    const pack=driving();mutate(pack);assert.throws(()=>validatePack(pack));
  }
});

test('large vocabulary sharing indexes existing questions once and coalesces identical source IDs',()=>{
  const pack=driving(),store=new Store(':memory:');
  try {
    const base=pack.questions[0];
    pack.questions=Array.from({length:2000},(_,i)=>({...base,id:'VOCAB-'+i,title:'term-'+i}));
    pack.questions.push({...pack.questions[0],id:'VOCAB-duplicate'});
    pack.questionBanks=[];pack.papers=[];pack.assets=[];
    let questionScans=0;const all=store.all.bind(store);
    store.all=((table:any)=>{if(table==='questions')questionScans++;return all(table);}) as typeof store.all;
    const plan=planShareImport(store,asShare(pack,'large vocabulary'));
    assert.equal(plan.preview.counts.questions.added,2000);
    assert.equal(new Set(plan.preview.questions.map(q=>q.id)).size,2000);
    assert.ok(questionScans<=3,`Unexpected full scans: ${questionScans}`);
  }finally{store.db.close();}
});

test('500-question share parts keep distinct deterministic sets, complete wordlists, and all references',()=>{
  const pack=vocabulary(600);
  pack.questions[0].explanationMarkdown='See [word-600](#/questions/EN-V-000600) for a related meaning.';
  pack.questions[500].explanationMarkdown='See [word-502](#/questions/EN-V-000502) for a related meaning.';
  const papers=wordlistPapers(pack),parts=[pack.questions.slice(0,500),pack.questions.slice(500)].map((questions:any[],index)=>{
    const selected=new Set(questions.map(q=>q.id));return asShare(pack,`Part ${index+1}`,questions,papers.filter(p=>p.questionIds.every(id=>selected.has(id))));
  });
  const full=asShare(pack,'All words');
  const sourceSet=(part:any)=>part.papers.find((paper:any)=>paper.id.startsWith('en-fixture-bank'));
  assert.deepEqual(full.questionBanks,[]);
  assert.equal(sourceSet(full).id,'en-fixture-bank');
  assert.notEqual(sourceSet(parts[0]).id,sourceSet(parts[1]).id);
  assert.notEqual(sourceSet(parts[0]).id,sourceSet(full).id);
  assert.match(sourceSet(parts[0]).title,/分包/);
  assert.equal(sourceSet(asShare(pack,'Repeat',pack.questions.slice(0,500))).id,sourceSet(parts[0]).id);
  assert.deepEqual(parts.map(part=>part.papers.length),[6,2]);
  assert.doesNotMatch(parts[0].questions[0].explanationMarkdown,/#\/questions\/EN-V-000600/);
  assert.match(parts[1].questions[0].explanationMarkdown,/#\/questions\/EN-V-000502/);
  const store=new Store(':memory:');
  try {
    for(const part of parts){const plan=planShareImport(store,part);importShare(store,part,plan.preview.fingerprint);}
    assert.equal(store.all('questions').length,600);assert.equal(store.all('papers').length,8);assert.equal(store.all('question_banks').length,0);
    for(const paper of store.all<any>('papers').filter(p=>p.id.startsWith('wordlist-'))){
      assert.equal(paper.snapshot.length,100);assert.equal(paper.archived,true);assert.equal(paper.scoring.enabled,false);
      assert.deepEqual(paper.snapshot.map((q:any)=>q.id),paper.questionIds);
      assert.ok(paper.questionIds.every((id:string)=>Boolean(store.get('questions',id))));
    }
    for(const part of parts){const plan=planShareImport(store,part);assert.equal(plan.preview.counts.questions.added,0);importShare(store,part,plan.preview.fingerprint);}
    assert.equal(store.all('question_banks').length,0);assert.equal(store.all('papers').length,8);assert.ok(store.all<any>('questions').every(q=>q.status==='pending'));
  } finally {store.db.close();}
});

test('omitted taxonomy defaults are normalized before import compatibility checks',()=>{
  const raw=vocabulary(2);
  delete raw.domains[0].description;delete raw.domains[0].sortOrder;
  delete raw.categories[0].description;delete raw.categories[0].sortOrder;delete raw.categories[0].parentId;
  delete raw.tags[0].description;delete raw.tags[0].color;delete raw.tags[0].kind;delete raw.tags[0].domainId;
  delete raw.papers[0].description;
  const pack=validatePack(raw),store=new Store(':memory:');
  try {
    assert.equal(pack.domains[0].sortOrder,0);assert.equal(pack.categories[0].parentId,null);assert.equal(pack.tags[0].domainId,null);assert.equal(pack.tags[0].kind,'topic');
    assertImportCompatible(store,[pack]);const first=importData(store,{...pack,papers:[...pack.papers,...wordlistPapers(pack)]});
    assert.equal(first.counts.questions.added,2);
    assert.doesNotThrow(()=>assertImportCompatible(store,[validatePack(raw)]));
    const second=importData(store,{...pack,papers:[...pack.papers,...wordlistPapers(pack)]});
    assert.equal(second.counts.questions.added,0);assert.equal(second.counts.questions.skipped,2);assert.equal(store.all('papers').length,2);
  }finally{store.db.close();}
});

test('reimport preserves local approval, study notes and wordlist archive/version transitions',()=>{
  const pack=vocabulary(2),store=new Store(':memory:'),papers=wordlistPapers(pack);
  try {
    importData(store,{...pack,papers});const qid=pack.questions[0].id,q=store.require<any>('questions',qid),paper=store.require<any>('papers',papers[0].id);
    store.put('questions',qid,{...q,status:'published',updatedAt:'2026-10-22T09:00:00Z'});
    store.put('study',qid,{...store.study(qid),notes:'User note must survive a repeated content import.'});
    store.put('papers',paper.id,{...paper,archived:false,version:3,updatedAt:'2026-10-22T09:30:00Z'});
    assert.doesNotThrow(()=>assertImportCompatible(store,[pack]));importData(store,{...pack,papers});
    assert.equal(store.require<any>('questions',qid).status,'published');assert.match(store.study(qid).notes,/must survive/);
    assert.equal(store.require<any>('papers',paper.id).archived,false);assert.equal(store.require<any>('papers',paper.id).version,3);
  }finally{store.db.close();}
});

test('same ID with different local meaning is rejected for questions and generated wordlists',()=>{
  for(const table of ['questions','papers'] as const){
    const pack=vocabulary(1),store=new Store(':memory:');
    try {
      const papers=wordlistPapers(pack);importData(store,{...pack,papers});const id=table==='questions'?pack.questions[0].id:papers[0].id,record=store.require<any>(table,id);
      store.put(table,id,{...record,[table==='questions'?'answerMarkdown':'title']:'Locally edited meaning'});
      assert.throws(()=>assertImportCompatible(store,[pack]),/本地ID存在不同内容/);
      assert.equal(store.require<any>(table,id)[table==='questions'?'answerMarkdown':'title'],'Locally edited meaning');
    }finally{store.db.close();}
  }
});

test('multiple packs allow identical shared IDs but reject different incoming meanings before writes',()=>{
  const pack=vocabulary(1),copy=structuredClone(pack);
  copy.questions[0]=Object.fromEntries(Object.entries(copy.questions[0]).reverse());
  assert.doesNotThrow(()=>validatePackSet([pack,copy]));
  for(const mutate of [(p:any)=>{p.questions[0].answerMarkdown='Conflicting answer';},(p:any)=>{p.domains[0].name='Conflicting domain';},(p:any)=>{p.papers[0].description='Conflicting set';}]){
    const altered=structuredClone(pack),store=new Store(':memory:');mutate(altered);
    try{assert.throws(()=>assertImportCompatible(store,[pack,altered]),/内容包之间存在不同内容的相同ID/);assert.equal(store.all('questions').length,0);assert.equal(store.all('domains').length,0);}
    finally{store.db.close();}
  }
});

test('raw question study state and duplicate set IDs cannot enter generic content packs',()=>{
  const withNotes=vocabulary(1);withNotes.questions[0].study={notes:'Personal notes'};assert.throws(()=>validatePack(withNotes),/generic and pending/);
  const duplicateSet=vocabulary(1);duplicateSet.papers.push(structuredClone(duplicateSet.papers[0]));assert.throws(()=>validatePack(duplicateSet),/Invalid content paper/);
  const retired=vocabulary(1);retired.questionBanks=[{id:'old',name:'Old',questionIds:[retired.questions[0].id]}];assert.throws(()=>validatePack(retired),/Retired collections/);
  const wrongSnapshot=vocabulary(1);wrongSnapshot.papers[0].snapshot=structuredClone(wrongSnapshot.papers[0].snapshot);wrongSnapshot.papers[0].snapshot[0].answerMarkdown='A different frozen answer';assert.throws(()=>validatePack(wrongSnapshot),/snapshot differs/);
  const missingMember=vocabulary(1);missingMember.papers[0].questionIds=['MISSING'];assert.throws(()=>validatePack(missingMember),/Invalid content paper/);
});

test('standalone parts rewrite queried links throughout group questions but preserve local and external destinations',()=>{
  const raw=vocabulary(3),external='https://example.org/#/questions/EXTERNAL-ONLY?answer=1';
  raw.papers=[];
  raw.questions[0]={...raw.questions[0],type:'group',stemMarkdown:'Read [inside](#/questions/EN-V-000002?answer=1) and [outside](#/questions/EN-V-000003?answer=1).',parts:[
    {id:'p1',title:'Choose a related word',type:'single_choice',stemMarkdown:'Use the linked meanings.',answerMarkdown:'B',explanationMarkdown:`The external reference ${external} is unrelated to local IDs.`,options:[{key:'A',text:'[Other pack](#/questions/EN-V-000003?answer=1)'},{key:'B',text:'[This pack](#/questions/EN-V-000002?answer=1)'}],correctAnswers:['B']},
    {id:'p2',title:'Explain the relation',type:'short_answer',stemMarkdown:'Bare reference: #/questions/EN-V-000003?answer=1',answerMarkdown:'A short explanation.',explanationMarkdown:`See [external](${external}) for an external example.`,options:[],correctAnswers:[]},
  ],sourceRefs:[{label:'Outside this part',url:'#/questions/EN-V-000003?answer=1'},{label:'Inside this part',url:'#/questions/EN-V-000002?answer=1'},{label:'External fragment',url:external}]};
  const pack=validatePack(raw),original=JSON.stringify(pack),share=asShare(pack,'Standalone group part',pack.questions.slice(0,2)),q=share.questions[0];
  assert.equal(JSON.stringify(pack),original,'Preparing one part must not mutate the full pack');
  assert.match(q.stemMarkdown,/#\/questions\/EN-V-000002\?answer=1/);
  assert.doesNotMatch(q.stemMarkdown,/#\/questions\/EN-V-000003/);
  assert.match(q.parts[0].options[0].text,/Other pack（关联词在其他分包）/);
  assert.match(q.parts[0].options[1].text,/#\/questions\/EN-V-000002\?answer=1/);
  assert.equal(q.parts[1].stemMarkdown,'Bare reference: #/questions?search=EN-V-000003');
  assert.equal(q.sourceRefs[0].url,'#/questions?search=EN-V-000003');
  assert.equal(q.sourceRefs[1].url,'#/questions/EN-V-000002?answer=1');assert.equal(q.sourceRefs[2].url,external);
  assert.ok(q.parts[0].explanationMarkdown.includes(external));assert.ok(q.parts[1].explanationMarkdown.includes(external));
  const store=new Store(':memory:');try{const plan=planShareImport(store,share);importShare(store,share,plan.preview.fingerprint);assert.equal(store.all('questions').length,2);assert.equal(store.require<any>('questions',q.id).parts.length,2);}finally{store.db.close();}
  for(const mutate of [(p:any)=>{p.questions[0].parts[0].options[0].text='[missing](#/questions/MISSING?answer=1)';},(p:any)=>{p.questions[0].parts[1].stemMarkdown='Bare #/questions/MISSING?answer=1';},(p:any)=>{p.questions[0].sourceRefs[0].url='#/questions/MISSING?answer=1';}]){
    const broken=structuredClone(raw);mutate(broken);assert.throws(()=>validatePack(broken),/Broken related-word link/);
  }
});
