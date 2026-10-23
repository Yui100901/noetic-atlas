/** Explicit local catalog maintenance. New-content import still defaults to pending. */
import { existsSync } from 'node:fs';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store, nextStamp, tables } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { enrichKnowledgePack, decideKnowledgeTags, OUTDATED_TAG, OBSOLETE_TAG } from '../../shared/questions/knowledge-tags.js';
import type { Category, Question, Tag } from '../../shared/models/types.js';
import { validatePack } from './manage.js';

const root=resolve(import.meta.dirname,'../..');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const counts=(values:string[])=>Object.fromEntries([...new Set(values)].sort().map(key=>[key,values.filter(value=>value===key).length]));

export function planCatalog(store:Store,approveAll=false) {
  const before={...store.taxonomy(),questions:store.all<Question>('questions')};
  const enriched=enrichKnowledgePack(before);
  const categoryMap=new Map(before.categories.map(c=>[c.id,c])),tagMap=new Map(enriched.tags.map(t=>[t.id,t]));
  const questions=enriched.questions.map(q=>{
    questionSchema.parse(q);
    if(!q.categoryIds.length||!q.tagIds.length)throw new Error('Unclassified question '+q.id);
    for(const cid of q.categoryIds)if(!categoryMap.has(cid))throw new Error('Missing category '+cid);
    const domains=new Set(q.categoryIds.map(cid=>categoryMap.get(cid)!.domainId));
    for(const tid of q.tagIds){const tag=tagMap.get(tid);if(!tag||tag.domainId&&!domains.has(tag.domainId))throw new Error('Invalid tag '+q.id+'/'+tid);}
    return approveAll?{...q,status:'published' as const}:q;
  });
  const original=new Map(before.questions.map(q=>[q.id,q]));
  const changed=questions.filter(q=>!same(q,original.get(q.id)));
  const byDomain=before.domains.map(d=>({id:d.id,name:d.name,questions:questions.filter(q=>q.categoryIds.some(cid=>categoryMap.get(cid)!.domainId===d.id)).length}));
  const perQuestion=questions.map(q=>{const decision=decideKnowledgeTags(q,categoryMap,tagMap);return {id:q.id,categoryIds:q.categoryIds,tagIds:q.tagIds,status:q.status,reasons:decision.reasons,...(decision.evidence?{evidence:decision.evidence}:{} )};});
  return {tags:enriched.tags,questions,changed,report:{asOf:today(),policy:'全库分类与标签规则扫描；审核是用户授权的发布状态，不等同于逐题专家鉴定。基础化学身份、医学地区适用性、历史驾驶答案与版本细节分别保留来源和边界。',approvalRequested:approveAll,total:questions.length,changed:changed.length,beforeStatus:counts(before.questions.map(q=>q.status)),afterStatus:counts(questions.map(q=>q.status)),byDomain,types:counts(questions.map(q=>q.type)),tags:enriched.tags.length,tagCoverage:questions.filter(q=>q.tagIds.length).length,methodCoverage:questions.filter(q=>q.tagIds.some(id=>tagMap.get(id)?.kind==='method')).length,possiblyOutdated:questions.filter(q=>q.tagIds.includes(OUTDATED_TAG)).length,confirmedOutdated:questions.filter(q=>q.tagIds.includes(OBSOLETE_TAG)).length,tagCounts:Object.fromEntries(enriched.tags.map(tag=>[tag.id,questions.filter(q=>q.tagIds.includes(tag.id)).length])),confirmedEvidence:perQuestion.filter(q=>q.evidence),questions:perQuestion}};
}

export function applyCatalog(store:Store,plan:ReturnType<typeof planCatalog>) {
  const questions=new Map(plan.questions.map(q=>[q.id,q]));
  store.transaction(()=>{
    for(const tag of plan.tags){const previous=store.get<Tag>('tags',tag.id);if(!same(previous,tag))store.put('tags',tag.id,tag);}
    for(const q of plan.changed)store.put('questions',q.id,{...q,updatedAt:nextStamp(q.updatedAt)});
    // Paper content and original answer/status snapshots stay frozen. Only the
    // topic metadata follows its source question; attempts are never rewritten.
    for(const paper of store.all<any>('papers')){
      let changed=false;
      const snapshot=paper.snapshot?.map((q:Question)=>{const source=questions.get(q.id);if(!source||same(q.tagIds,source.tagIds))return q;changed=true;return {...q,tagIds:source.tagIds};});
      if(changed)store.put('papers',paper.id,{...paper,snapshot});
    }
    store.validateTaxonomyReferences();
  });
}

async function syncSources() {
  const seedPath=join(root,'data/seed.json'),seed=JSON.parse(await readFile(seedPath,'utf8'));
  await writeFile(seedPath,JSON.stringify(enrichKnowledgePack(seed))+'\n');
  const changed=[];
  for(const filename of (await readdir(join(root,'data/content-packs'))).filter(name=>name.endsWith('.json')).sort()){
    const path=join(root,'data/content-packs',filename),text=await readFile(path,'utf8'),raw=JSON.parse(text),normalized=validatePack(raw);
    // Keep new-content workflow pending, even when the local bank was approved.
    const output=JSON.stringify({...raw,tags:normalized.tags,questions:normalized.questions})+'\n';
    if(output!==text)await writeFile(path,output);
    const metadataPath=join(root,'data/content-sources',filename);
    if(existsSync(metadataPath)){
      const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
      metadata.catalogNormalization={asOf:today(),policy:'global knowledge tags and explicit historical validity annotations; pending status retained',generatorOutputSha256:metadata.catalogNormalization?.generatorOutputSha256||sha(text),outputSha256:sha(output),questions:normalized.questions.length};
      if(typeof metadata.sha256==='string')metadata.sha256=sha(output);
      if(typeof metadata.bytes==='number')metadata.bytes=Buffer.byteLength(output);
      await writeFile(metadataPath,JSON.stringify(metadata,null,2)+'\n');
    }
    changed.push({file:filename,questions:normalized.questions.length,sha256:sha(output)});
  }
  return changed;
}

export async function main(args=process.argv.slice(2)) {
  let database=join(root,'data/noetic-atlas.sqlite'),apply=false,approveAll=false,sources=false;
  while(args.length){const option=args.shift();if(option==='--database'){const value=args.shift();if(!value)throw new Error('--database requires a path');database=resolve(value);}else if(option==='--apply')apply=true;else if(option==='--approve-all')approveAll=true;else if(option==='--sync-sources')sources=true;else throw new Error('Unknown option '+option);}
  if(!existsSync(database))throw new Error('Database not found');
  if(sources&&!apply)throw new Error('--sync-sources requires --apply');
  const store=new Store(database);
  try {
    const plan=planCatalog(store,approveAll),protectedTables=tables.filter(table=>!['tags','questions','papers'].includes(table));
    const protectedBefore=new Map(protectedTables.map(table=>[table,sha(JSON.stringify(store.all(table)))]));
    let backup:string|null=null;
    if(apply){
      await mkdir(join(root,'data/backups'),{recursive:true});backup=join(root,'data/backups',`before-catalog-review-${Date.now()}.sqlite`);
      store.database.snapshotTo(backup);
      if(sources)await syncSources();
      applyCatalog(store,plan);
      for(const table of protectedTables)if(protectedBefore.get(table)!==sha(JSON.stringify(store.all(table))))throw new Error('Unexpected protected-table mutation '+table);
    }
    const report={...plan.report,applied:apply,backup:backup?relative(root,backup):null,protectedTablesPreserved:true};
    await mkdir(join(root,'test-results/content/catalog-review'),{recursive:true});
    await writeFile(join(root,'test-results/content/catalog-review/report.json'),JSON.stringify(report,null,2)+'\n');
    const {questions,tagCounts,confirmedEvidence,...summary}=report;
    console.log(JSON.stringify({...summary,confirmedEvidenceIds:confirmedEvidence.map(q=>q.id)},null,2));
  }finally{store.db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
