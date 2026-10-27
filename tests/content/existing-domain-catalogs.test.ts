import test from 'node:test';
import assert from 'node:assert/strict';
import {conceptPromptIsSafe} from '../../shared/questions/concept.js';
const files=['medicine-catalog','existing-computer','existing-physics','existing-chemistry','existing-psychology','existing-chinese','existing-english','existing-japanese','existing-driving'];
async function catalogs(){return Promise.all(files.map(async name=>(await import('../../scripts/content/expansion-2026-10b/'+name+'.mjs')).default));}
test('all existing-domain catalogs supply independent concepts, valid objective keys and attributed explanations',async()=>{
 let total=0,objective=0;const domains=new Set<string>();
 for(const catalog of await catalogs()){
  domains.add(catalog.domainId);
  for(const row of catalog.concepts||[]){total++;assert.ok(conceptPromptIsSafe({term:row.term,meaningPrompt:row.definition,acceptedAnswers:[row.term,...row.aliases||[]]}),row.term);assert.ok(row.distinction.length>=15,row.term);}
  for(const row of catalog.questions){total++;objective++;assert.ok(row.explanation.length>=12,row.stem);assert.ok(!/\{\{(?:answer|blank)/i.test(row.stem),row.stem);
   const group=catalog.groups[row.group];assert.ok((row.sources||group?.sources)?.length,row.stem);
   if(row.type==='true_false')assert.equal(typeof row.correct,'boolean');
   if(row.type.includes('choice')){assert.equal(new Set(row.options).size,row.options.length,row.stem);const keys=Array.isArray(row.correct)?row.correct:[row.correct];assert.ok(keys.every((key:string)=>'ABCDEF'.indexOf(key)>=0&&'ABCDEF'.indexOf(key)<row.options.length),row.stem);}
   if(row.type==='fill_blank'){assert.ok(row.stem.includes('____'),row.stem);assert.ok(row.blanks.length&&row.blanks.every((b:any)=>b.answers.length>0));}
  }
  for(const group of Object.values(catalog.groups) as any[])for(const source of group.sources){const url=new URL(source.url);assert.equal(url.protocol,'https:');assert.equal(url.password,'');assert.ok(!/example\.(com|org)/.test(url.hostname));}
 }
 assert.equal(domains.size,9);assert.ok(total>=500);assert.ok(objective>=350);
});
test('medicine distinguishes exposure, potency, therapeutic window and uncertainty without suggesting individual dosing',async()=>{
 const med=(await catalogs())[0],byTerm=new Map<string,any>(med.concepts.map((q:any)=>[q.term,q]));
 assert.match(byTerm.get('内暴露').distinction,/检出不自动等于/);
 assert.match(byTerm.get('药物效价').distinction,/不自动表示更安全/);
 assert.match(byTerm.get('治疗窗').distinction,/不是完全同一/);
 assert.match(byTerm.get('零级消除动力学').distinction,/不宜.*半衰期/);
 assert.ok(!med.questions.some((q:any)=>/你.*(?:服用|注射).*\d+\s*mg/i.test(q.stem)));
});
test('language additions test grammar and punctuation rather than another vocabulary dump',async()=>{
 const values=await catalogs();for(const id of ['chinese','english','japanese']){const catalog=values.find(c=>c.domainId===id);assert.ok(catalog);assert.equal(catalog.concepts.length,0);assert.ok(catalog.questions.length>=25);assert.ok(catalog.questions.every((q:any)=>['true_false','single_choice','fill_blank','multiple_choice'].includes(q.type)));}
});
