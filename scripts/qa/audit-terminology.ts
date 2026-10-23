/** Validate the real terminology corpus and its optional lexical references. */
import{readFile,readdir,mkdir,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import assert from'node:assert/strict';
import{validatePack,validatePackSet,asShare}from'../content/manage.js';import{Store}from'../../server/core/store.js';import{importData}from'../../server/modules/transfer/migration.js';
const output='test-results/terminology',names=(await readdir('data/content-packs')).filter(n=>/^terms-.*\.json$/.test(n)).sort();
const english=JSON.parse(await readFile('data/content-packs/english.json','utf8')),normalize=(s:string)=>s.normalize('NFKC').trim().toLowerCase(),words=new Set(english.questions.filter((q:any)=>q.id.startsWith('EN-V-')).map((q:any)=>normalize(q.title)));
const heads=new Map<string,string>(),ids=new Set<string>(),abbreviations=new Map<string,any[]>(),packs=[],summary=[];let referenceQuestions=0,links=0;
for(const file of names){
 const text=await readFile('data/content-packs/'+file,'utf8'),raw=JSON.parse(text),pack=validatePack(raw),meta=JSON.parse(await readFile('data/content-sources/'+file,'utf8'));
 assert.equal(meta.sha256,createHash('sha256').update(text).digest('hex'),file+' output hash');assert.equal(meta.entries.length,pack.questions.length);
 for(const q of pack.questions){assert.ok(!ids.has(q.id),q.id);ids.add(q.id);assert.equal(q.status,'pending');assert.equal(q.collection,'general');assert.equal(q.type,'short_answer');assert.ok(q.tagIds.includes('method-terminology'));assert.ok(q.tagIds.includes('method-reference'));let related=0;for(const link of q.explanationMarkdown.matchAll(/#\/vocabulary\/([^\s)]+)/g)){assert.ok(words.has(normalize(decodeURIComponent(link[1]))),q.id+' -> '+link[1]);related++;}links+=related;if(related)referenceQuestions++;}
 for(const e of meta.entries){const key=e.domainId+':'+normalize(e.term);assert.ok(!heads.has(key),'Duplicate head '+key+' '+heads.get(key)+' / '+e.id);heads.set(key,e.id);for(const alias of e.aliases){if(!/^[A-Z][A-Z0-9/.-]{1,12}$/.test(alias))continue;abbreviations.set(alias,[...(abbreviations.get(alias)||[]),{id:e.id,term:e.term,english:e.english,domainId:e.domainId}]);}}
 summary.push({pack:file.slice(0,-5),questions:pack.questions.length,lexicalReferenceQuestions:meta.lexicalReferenceQuestions,groups:meta.groups});packs.push(pack);
 // Every single-term share remains usable without copying its English cards.
 const share=asShare(pack,'Single concept',[pack.questions[0]]);assert.equal(share.questions.length,1);assert.ok(!share.questions[0].id.startsWith('EN-V-'));
}
validatePackSet(packs);const memory=new Store(':memory:');try{for(const pack of packs)importData(memory,pack);assert.equal(memory.all('questions').length,ids.size);memory.validateTaxonomyReferences();}finally{memory.db.close();}
await mkdir(output,{recursive:true});const report={asOf:'2026-10-23',total:ids.size,packs:summary,uniqueHeads:heads.size,lexicalReferenceQuestions:referenceQuestions,lexicalReferences:links,ambiguities:[...abbreviations].filter(([,items])=>items.length>1).map(([alias,meanings])=>({alias,meanings})),status:'pending',generic:true,realImportsPassed:true};await writeFile(output+'/content-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
