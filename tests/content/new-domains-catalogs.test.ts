import test from 'node:test';
import assert from 'node:assert/strict';
import { conceptPromptIsSafe } from '../../shared/questions/concept.js';

async function catalogs() {
  const base='../../scripts/content/expansion-2026-10b/';
  return Promise.all(['linguistics','music','geography','economics'].map(async name=>(await import(base+name+'.mjs')).default));
}

test('new-domain and public-finance catalogs have independent reversible concepts and complete objective answers',async()=>{
  const items=await catalogs();let concepts=0,objective=0;
  for(const catalog of items){
    const identities=new Set<string>();
    for(const row of catalog.concepts){
      const identity=row.term.normalize('NFKC').toLowerCase();assert.ok(!identities.has(identity),identity);identities.add(identity);concepts++;
      assert.ok(row.definition.trim()&&row.distinction.length>=15,row.term);
      assert.ok(conceptPromptIsSafe({term:row.term,meaningPrompt:row.definition,acceptedAnswers:[row.term,...row.aliases||[]]}),row.term);
      assert.ok(!/\{\{.*?\}\}/.test(row.definition+row.distinction),row.term);
      assert.ok(catalog.groups[row.group]?.sources?.length,row.term);
    }
    for(const row of catalog.questions){
      objective++;assert.ok(row.explanation.length>=15,row.stem);
      if(row.type==='true_false')assert.equal(typeof row.correct,'boolean');
      else {
        const answerKeys=Array.isArray(row.correct)?row.correct:[row.correct];
        assert.ok(row.options.length>=2&&new Set(row.options).size===row.options.length,row.stem);
        if(row.type==='single_choice')assert.equal(answerKeys.length,1);
        if(row.type==='multiple_choice')assert.ok(answerKeys.length>=2);
        assert.ok(answerKeys.every((key:string)=>'ABCDEF'.indexOf(key)>=0&&'ABCDEF'.indexOf(key)<row.options.length),row.stem);
      }
    }
    for(const group of Object.values(catalog.groups) as any[])for(const source of group.sources){
      const url=new URL(source.url);assert.equal(url.protocol,'https:');assert.equal(url.username,'');assert.equal(url.password,'');
    }
  }
  assert.ok(concepts>=480&&objective>=110);
  for(const id of ['linguistics','music'])assert.ok(items.find(c=>c.domainId===id).concepts.length>=130);
});

test('language genealogy is distinguished from typology, writing systems and naming conventions',async()=>{
  const [ling]=await catalogs(), byTerm=new Map<string,any>(ling.concepts.map((r:any)=>[r.term,r]));
  assert.match(byTerm.get('孤立语言').distinction,/不表示没有祖先/);
  assert.match(byTerm.get('孤立型语言').distinction,/谱系孤立语言无关/);
  assert.match(byTerm.get('阿尔泰语系假说').distinction,/重大争议/);
  assert.match(byTerm.get('汉语族').distinction,/社会政治.*不应.*完全听懂/);
  assert.equal(ling.questions.find((q:any)=>/日语.*汉字.*汉藏/.test(q.stem)).correct,false);
});

test('music facts preserve pitch spelling, compound subdivisions and Chinese terminology boundaries',async()=>{
  const [,music]=await catalogs(), byTerm=new Map<string,any>(music.concepts.map((r:any)=>[r.term,r]));
  assert.match(byTerm.get('compound meter').definition,/三个/);
  assert.match(byTerm.get('compound meter').distinction,/不要与中文传统/);
  assert.match(byTerm.get('复附点').distinction,/7\/4/);
  assert.match(byTerm.get('音级').distinction,/C与C升属于不同/);
  const beat=music.questions.find((q:any)=>/440Hz.*442Hz/.test(q.stem));assert.equal(beat.correct,true);
  assert.equal(music.questions.find((q:any)=>/根音一定是/.test(q.stem)).correct,false);
});

test('water and fiscal distinctions retain physical conditions, probability and current-law dates',async()=>{
  const [,,geo,econ]=await catalogs();
  assert.ok(geo.questions.some((q:any)=>/气压与水汽混合比基本不变/.test(q.stem)&&q.options?.[0]==='降低'));
  assert.ok(geo.questions.some((q:any)=>/水蒸发吸收能量.*水汽凝结释放能量/.test(q.stem)&&q.correct===true));
  assert.equal(geo.questions.find((q:any)=>/接下来99年/.test(q.stem)).correct,false);
  assert.ok(econ.questions.some((q:any)=>/2026年1月1日.*旧暂行条例/.test(q.stem)&&q.correct===true));
  assert.equal(econ.questions.find((q:any)=>/价外税.*消费者不可能/.test(q.stem)).correct,false);
  assert.equal(econ.questions.find((q:any)=>/指定由卖方缴税/.test(q.stem)).correct,false);
  assert.ok(econ.groups.vat.sources.every((s:any)=>/chinatax\.gov\.cn/.test(new URL(s.url).hostname)));
});
