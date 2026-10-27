/** Explicit offline maintenance for the user's authorized 2026-10 expansion.
 * Dry-run is default. Applying requires --apply and first takes an independent
 * SQLite backup and completes the same transaction on a disposable copy. */
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile,mkdir,readFile,readdir,unlink,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store,nextStamp} from '../../server/core/store.js';
import {DatabaseConnection} from '../../server/database/connection.js';
import {recordTables,type RecordTable} from '../../server/database/schema.js';
import {questionSchema} from '../../server/core/validation.js';
import type {Question,Category,Domain} from '../../shared/models/types.js';
import {buildPaper,type StoredPaper} from '../../server/modules/practice/service.js';
import {validatePack} from './manage.js';
import {applyKnowledgeExpansion} from './apply-knowledge-expansion.js';
import {normalizeBankEditorial} from './editorial-normalization.js';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function syncEditorialManifest(root:string,change:{path:string;count:number;previousSha256:string;sha256:string},at=new Date().toISOString()){
  const path=join(root,'data/content-sources',basename(change.path)==='seed.json'?'seed-editorial-normalization.json':basename(change.path));
  const manifest=existsSync(path)?JSON.parse(await readFile(path,'utf8')):{};
  manifest.editorialNormalization={at,questions:change.count,previousFileSha256:change.previousSha256,fileSha256:change.sha256,previousManifestSha256:manifest.sha256||null,policy:'Lossless answer/explanation section separation and known fill-placeholder formatting. Attribution, answers and source publication policy are retained.'};
  manifest.sha256=change.sha256;await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(manifest,null,2)+'\n');
}
function recordDigest(store:Store,table:RecordTable){
  const hash=createHash('sha256');let cursor:string|undefined;
  while(true){let query=store.database.query.selectFrom(table).select(['id','data']).orderBy('id').limit(table==='assets'?1:200);if(cursor)query=query.where('id','>',cursor);const rows=store.database.all(query);if(!rows.length)break;for(const row of rows){hash.update(JSON.stringify([row.id,row.data]));cursor=row.id;}}
  return hash.digest('hex');
}
function appendConceptSets(store:Store){
  const categories=new Map(store.all<Category>('categories').map(c=>[c.id,c.domainId]));
  const eligible=store.all<Question>('questions').filter(q=>q.status==='published'&&q.collection==='general'&&q.type==='short_answer'&&q.concept);
  const papers=store.all<StoredPaper>('papers'),created:string[]=[];
  for(const domain of store.all<Domain>('domains')){
    const prefix=`concept-cards-202610-${domain.id}-`,previous=papers.filter(p=>p.id.startsWith(prefix)&&p.practiceKind==='concept'&&p.domainId===domain.id);
    const covered=new Set(previous.flatMap(p=>p.questionIds)),selected=eligible.filter(q=>!covered.has(q.id)&&q.categoryIds.some(id=>categories.get(id)===domain.id)).sort((a,b)=>a.id.localeCompare(b.id));
    const first=1+Math.max(0,...previous.map(p=>Number(p.id.slice(prefix.length))).filter(Number.isSafeInteger));
    for(let start=0;start<selected.length;start+=100){const batch=selected.slice(start,start+100),index=first+start/100,id=prefix+index;if(store.get('papers',id))throw Error('Concept set ID conflict: '+id);const paper=buildPaper(store,{id,title:`${domain.name}概念卡 ${index}（${batch.length}题）`,description:'在开始练习时选择概念→含义或描述→概念。',mode:'manual',practiceKind:'concept',questionIds:batch.map(q=>q.id),organization:'domain',domainId:domain.id,scoring:{enabled:false}});store.insert('papers',id,paper);created.push(id);}
  }
  return created;
}
export function completeContentRound(store:Store,packs:ReturnType<typeof validatePack>[],createSets=false){
  return store.transaction(()=>{
    const protectedTables=recordTables.filter(table=>!['questions','domains','categories','tags','papers'].includes(table));
    const baseline=new Map(protectedTables.map(table=>[table,recordDigest(store,table)]));
    const oldPapers=new Map(store.database.all(store.database.query.selectFrom('papers').select(['id','data'])).map(row=>[row.id,sha(row.data)]));
    const imported=applyKnowledgeExpansion(store,packs,{format:'noetic-atlas-concept-supplement',schemaVersion:1,generatedAt:new Date().toISOString(),questions:[]},false);
    let formattingFixed=0,explanationsSeparated=0,approved=0,changed=0,total=0;
    const statuses:Record<string,number>={},types:Record<string,number>={};
    for(const current of store.all<Question>('questions')){
      total++;const editorial=normalizeBankEditorial(current);
      if(editorial.stemMarkdown!==current.stemMarkdown||editorial.title!==current.title||JSON.stringify(editorial.parts)!==JSON.stringify(current.parts))formattingFixed++;
      if(editorial.explanationMarkdown!==current.explanationMarkdown)explanationsSeparated++;
      const status=['pending','draft'].includes(current.status)?'published' as const:current.status;
      if(status!==current.status)approved++;
      const candidate={...editorial,status};questionSchema.parse(candidate);store.validateRefs(candidate);
      if(JSON.stringify(candidate)!==JSON.stringify(current)){store.put('questions',current.id,{...candidate,updatedAt:nextStamp(current.updatedAt)});changed++;}
      statuses[status]=(statuses[status]||0)+1;types[current.type]=(types[current.type]||0)+1;
    }
    const createdSets=createSets?appendConceptSets(store):[];
    for(const table of protectedTables)if(recordDigest(store,table)!==baseline.get(table))throw Error('Protected table changed: '+table);
    for(const [id,digest]of oldPapers){const row=store.database.one(store.database.query.selectFrom('papers').select('data').where('id','=',id));if(!row||sha(row.data)!==digest)throw Error('Existing frozen set changed: '+id);}
    return{total,statuses,types,added:imported.imported.counts.questions?.added||0,formattingFixed,explanationsSeparated,approved,changed,createdSets,learningAndPrivateRecordsUnchanged:true,existingSetSnapshotsUnchanged:true};
  });
}
async function sourceChanges(root:string){
  const folder=join(root,'data/content-packs'),paths=(await readdir(folder)).filter(file=>file.endsWith('.json')).map(file=>join(folder,file));
  if(existsSync(join(root,'data/seed.json')))paths.push(join(root,'data/seed.json'));
  const changes:Array<{path:string;output:string;count:number;previousSha256:string;sha256:string}>=[];
  for(const path of paths){const original=await readFile(path,'utf8'),data=JSON.parse(original);let count=0;data.questions=data.questions.map((q:Question)=>{const next=normalizeBankEditorial(q);if(JSON.stringify(next)!==JSON.stringify(q)){questionSchema.parse(next);count++;}return next;});if(!count)continue;if(path!==join(root,'data/seed.json'))validatePack(data);const output=JSON.stringify(data,null,2)+'\n';changes.push({path,output,count,previousSha256:sha(original),sha256:sha(output)});}
  return changes;
}
async function main(){
  const args=process.argv.slice(2),value=(flag:string)=>{const at=args.indexOf(flag);return at<0?undefined:args[at+1];},root=resolve(import.meta.dirname,'../..');
  const database=resolve(value('--database')||'data/noetic-atlas.sqlite'),output=resolve(value('--report')||'test-results/content-quality/expansion-report.json'),apply=args.includes('--apply');
  if(!existsSync(database))throw Error('Database does not exist');
  const names=(value('--packs')||'').split(',').filter(Boolean);if(names.some(name=>!/^[a-z0-9-]+$/.test(name)))throw Error('Invalid pack name');
  const packs=await Promise.all(names.map(async name=>validatePack(JSON.parse(await readFile(join(root,'data/content-packs',name+'.json'),'utf8')))));
  await mkdir(dirname(output),{recursive:true});const backup=join(apply?join(dirname(database),'backups'):dirname(output),`${apply?'before-full-content-round':'preview-full-content-round'}-${Date.now()}.sqlite`);await mkdir(dirname(backup),{recursive:true});
  const connection=new DatabaseConnection(database,false);try{await connection.backupTo(backup);}finally{connection.close();}
  const changes=apply&&args.includes('--sync-sources')?await sourceChanges(root):[];
  const preview=apply?join(dirname(output),`preflight-content-round-${Date.now()}.sqlite`):backup;if(apply)await copyFile(backup,preview);
  const preflightStore=new Store(preview);let checked;
  try{checked=completeContentRound(preflightStore,packs,args.includes('--create-concept-sets'));}finally{preflightStore.db.close();}
  // Keep a failed preflight for diagnosis; remove a successful disposable copy.
  if(apply)await unlink(preview);
  if(!apply){await writeFile(output,JSON.stringify({mode:'dry-run',...checked},null,2));await unlink(backup);console.log(JSON.stringify({mode:'dry-run',...checked,createdSets:checked.createdSets.length}));return;}
  const store=new Store(database);let result;
  try{result=completeContentRound(store,packs,args.includes('--create-concept-sets'));}finally{store.db.close();}
  const report={at:new Date().toISOString(),mode:'apply',backup,packs:names,...result,sourceSync:{status:changes.length?'pending':'not_needed',files:changes.map(({path,count,previousSha256,sha256})=>({path,count,previousSha256,sha256}))}};
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  try{for(const change of changes){await writeFile(change.path,change.output);await syncEditorialManifest(root,change,report.at);}if(changes.length)report.sourceSync.status='completed';}catch(error){report.sourceSync.status='failed';throw error;}finally{await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify({...report,createdSets:report.createdSets.length}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
