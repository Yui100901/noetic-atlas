import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Store } from '../../server/core/store.js';
import { importData } from '../../server/modules/transfer/migration.js';
import { validatePack } from '../../scripts/content/manage.js';
import { planCatalog, applyCatalog } from '../../scripts/content/review.js';
import { enrichKnowledgePack, OUTDATED_TAG, OBSOLETE_TAG } from '../../shared/questions/knowledge-tags.js';

function fixture(){return validatePack(JSON.parse(readFileSync('tests/fixtures/driving-content.json','utf8')));}

test('knowledge tagging is idempotent and separates historical risk from proven obsolete answers',()=>{
  const pack=fixture();
  pack.questions[0].id='DRV-CAR-OFFICIAL-000044';
  pack.questions[1].id='DRV-CAR-OFFICIAL-000001';
  const tagged=enrichKnowledgePack(pack),again=enrichKnowledgePack(tagged);
  assert.deepEqual(again,tagged);
  assert.ok(tagged.questions[0].tagIds.includes(OUTDATED_TAG));
  assert.equal(tagged.questions[0].tagIds[0],OBSOLETE_TAG);
  assert.match(tagged.questions[0].explanationMarkdown,/现行官方依据/);
  assert.equal(tagged.questions[0].explanationMarkdown.split('<!-- current-validity-check -->').length,2);
  assert.ok(tagged.questions[1].tagIds.includes(OUTDATED_TAG));
  assert.ok(!tagged.questions[1].tagIds.includes(OBSOLETE_TAG));
  assert.equal(tagged.questions[2].status,'pending');
});

test('one medication question can reference two domains without duplicating its identity',()=>{
  const pack=fixture(),base=pack.questions[0];
  const tagged=enrichKnowledgePack({...pack,categories:[{...pack.categories[0],id:'chem-drugs',domainId:'chemistry'},{...pack.categories[0],id:'med-drugs',domainId:'medicine-pharmacy'}],tags:[],questions:[{...base,id:'MED-DRUG-000001',categoryIds:['chem-drugs','med-drugs'],tagIds:[]}]});
  assert.equal(tagged.questions.length,1);
  assert.ok(tagged.questions[0].tagIds.includes('method-reference'));
  assert.ok(!tagged.questions[0].tagIds.includes(OUTDATED_TAG));
  for(const domain of ['chemistry','medicine-pharmacy'])assert.ok(tagged.questions[0].tagIds.some(id=>tagged.tags.find(t=>t.id===id)?.domainId===domain));
});

test('English part-of-speech tags follow explicit selected senses, without treating adverb as verb',()=>{
  const pack=fixture(),base=pack.questions[0];
  const tagged=enrichKnowledgePack({...pack,categories:[{...pack.categories[0],id:'words',domainId:'english'}],tags:[],questions:[{...base,id:'EN-V-000001',categoryIds:['words'],tagIds:[],answerMarkdown:'**adverb / 副词 · x**\nMeaning.\n\n**noun / 名词 · y**\nAnother sense.'}]});
  assert.ok(tagged.questions[0].tagIds.includes('en-pos-adverb'));
  assert.ok(tagged.questions[0].tagIds.includes('en-pos-noun'));
  assert.ok(!tagged.questions[0].tagIds.includes('en-pos-verb'));
  assert.deepEqual(enrichKnowledgePack(tagged),tagged);
});

test('English vocabulary empty sections retain incomplete-reference tags after a clean rebuild',()=>{
  const pack=fixture(),base=pack.questions[0];
  const sections=[['使用方式／搭配','- use a word'],['例句','An independently authored example.'],['关联词汇','word; wording']];
  for(const [missingIndex]of sections.entries()){
    const newline=missingIndex===1?'\r\n':'\n';
    const explanationMarkdown=sections.map(([title,value],index)=>`### ${title}${newline}${newline}${index===missingIndex?'无':value}`).join(newline+newline)+newline+newline+'### 学习与审核说明'+newline+'保留原有来源署名。';
    const raw={...pack,categories:[{...pack.categories[0],id:'words',domainId:'english'}],tags:[],questions:[{...base,id:'EN-V-000001',categoryIds:['words'],tagIds:[],answerMarkdown:'**noun / 名词**\nA meaning.',explanationMarkdown}]};
    const tagged=enrichKnowledgePack(raw);
    assert.ok(tagged.questions[0].tagIds.includes('common-incomplete-reference'),sections[missingIndex]![0]);
    assert.ok(tagged.tags.some(tag=>tag.id==='common-incomplete-reference'));
    assert.deepEqual(enrichKnowledgePack(tagged),tagged);
  }
});

test('only empty English vocabulary fields trigger the short placeholder rule, preserving source warnings',()=>{
  const pack=fixture(),base=pack.questions[0];
  const complete='### 使用方式／搭配\n- a valid collocation\n\n### 例句\n无\n\n这里的“无”是正在解释的示例，正文并非空值。\n\n### 关联词汇\nrelated word';
  const cases=[
    {id:'EN-V-000001',text:complete,incomplete:false},
    {id:'EN-V-000002',text:'### 使用方式 / 搭配\n\n无\n\n## 其他说明\n真实来源信息。',incomplete:true},
    {id:'EN-V-000003',text:'### 其他说明\n无\n\n### 例句\nA complete example.',incomplete:false},
    {id:'TERM-FIX-no-alias',text:'### 别名或常用缩写\n无\n\n### 英文单词参考\n无',incomplete:false},
    {id:'TERM-FIX-scope',text:'### 使用方式／搭配\n无\n\n### 例句\n无\n\n### 关联词汇\n无',incomplete:false},
    {id:'EN-V-000004',text:'### 例句\n目前尚未匹配到可核验例句，此项待补充。',incomplete:true},
    {id:'JA-V-000001',text:'### 关联词汇\n无\n\n来源释义包含上游AI生成内容。',incomplete:false},
    {id:'EN-V-000005',text:'### 使用方式／搭配\n- take a break\n\n### 例句\nWe took a break after lunch.\n\n### 关联词汇\nrest; pause',incomplete:false},
  ];
  const tagged=enrichKnowledgePack({...pack,categories:[{...pack.categories[0],id:'words',domainId:'english'}],tags:[],questions:cases.map(item=>({...base,id:item.id,categoryIds:['words'],tagIds:[],answerMarkdown:'Meaning.',explanationMarkdown:item.text}))});
  for(const [index,item]of cases.entries())assert.equal(tagged.questions[index]!.tagIds.includes('common-incomplete-reference'),item.incomplete,item.id);
  const japanese=tagged.questions.find(question=>question.id==='JA-V-000001')!;
  assert.ok(japanese.tagIds.includes('common-ai-assisted'));
  assert.ok(japanese.tagIds.includes('common-syllabus-reference'));
  assert.equal(japanese.explanationMarkdown,cases[6]!.text);
  assert.deepEqual(enrichKnowledgePack(tagged),tagged);
});

test('whole-bank approval is explicit, preserves notes/config/history, and rolls back invalid references',()=>{
  const store=new Store(':memory:');
  try{
    const pack=fixture();importData(store,pack);
    const id=pack.questions[0].id;
    store.put('study',id,{...store.study(id),notes:'Keep personal notes'});
    store.put('settings','system',{value:123});store.put('attempts','attempt',{id:'attempt',snapshot:pack.questions});
    const paper={id:'paper',archived:true,version:7,snapshot:pack.questions};store.put('papers','paper',paper);
    const protectedBefore=['study','settings','attempts'].map(table=>store.all(table as any));
    const preview=planCatalog(store);assert.ok(preview.questions.every(q=>q.status==='pending'));
    assert.ok(store.all<any>('questions').every(q=>q.status==='pending'));
    applyCatalog(store,planCatalog(store,true));
    assert.ok(store.all<any>('questions').every(q=>q.status==='published'));
    assert.deepEqual(['study','settings','attempts'].map(table=>store.all(table as any)),protectedBefore);
    const after=store.require<any>('papers','paper');assert.equal(after.archived,true);assert.equal(after.version,7);
    assert.equal(after.snapshot[0].answerMarkdown,paper.snapshot[0].answerMarkdown);assert.equal(after.snapshot[0].status,'pending');
    const final=planCatalog(store,true);assert.equal(final.changed.length,0);
    const invalid={...final,changed:[{...final.questions[0],tagIds:['missing']}]};
    assert.throws(()=>applyCatalog(store,invalid));assert.ok(!store.require<any>('questions',id).tagIds.includes('missing'));
  }finally{store.db.close();}
});
