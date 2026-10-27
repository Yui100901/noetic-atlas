import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,copyFile,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store,nextStamp} from '../../../server/core/store.js';
import {DatabaseConnection} from '../../../server/database/connection.js';
import {recordTables,type RecordTable} from '../../../server/database/schema.js';
import {questionSchema} from '../../../server/core/validation.js';
import {validateAssetRecord} from '../../../server/modules/assets/schema.js';
import {validateAssetReferences} from '../../../server/modules/assets/routes.js';
import type {Question} from '../../../shared/models/types.js';
import type {StoredPaper} from '../../../server/modules/practice/service.js';
// @ts-expect-error Plain JavaScript authoring module, shared by package builds.
import {illustrateMusicQuestion} from './enrich.mjs';

function digest(store:Store,table:RecordTable){const h=createHash('sha256');let cursor:string|undefined;while(true){let query=store.database.query.selectFrom(table).select(['id','data']).orderBy('id').limit(table==='assets'?1:200);if(cursor)query=query.where('id','>',cursor);const rows=store.database.all(query);if(!rows.length)break;for(const row of rows){h.update(JSON.stringify([row.id,row.data]));cursor=row.id;}}return h.digest('hex');}
export function applyMusicIllustrations(store:Store,illustrations:any,targetIds:Set<string>){
 return store.transaction(()=>{
  const protectedTables=recordTables.filter(table=>!['questions','assets','papers'].includes(table));
  const before=new Map(protectedTables.map(table=>[table,digest(store,table)]));
  const updates=new Map<string,{before:Question;after:Question}>();
  for(const id of targetIds){const old=store.require<Question>('questions',id),value=illustrateMusicQuestion(old,illustrations) as Question;if(JSON.stringify(value)!==JSON.stringify(old)){const after={...value,updatedAt:nextStamp(old.updatedAt)};questionSchema.parse(after);updates.set(id,{before:old,after});}}
  const references=new Set([...updates.values()].flatMap(({after})=>[after.stemMarkdown,after.explanationMarkdown]).join('\n').match(/music-notation-[\w-]+/g)||[]);
  let addedAssets=0;
  for(const asset of illustrations.assets.filter((a:any)=>references.has(a.id))){validateAssetRecord(asset);const current=store.get<any>('assets',asset.id);if(current){if(current.dataBase64!==asset.dataBase64||current.mimeType!==asset.mimeType)throw Error('Asset identity collision: '+asset.id);}else{store.insert('assets',asset.id,asset);addedAssets++;}}
  for(const {after}of updates.values()){validateAssetReferences(store,after);store.put('questions',after.id,after);}
  const paperVersions:Array<{id:string;before:number;after:number}>=[];let customSnapshotsSkipped=0;
  for(const paper of store.all<StoredPaper>('papers')){
   let changed=false;const snapshot=paper.snapshot.map(q=>{const update=updates.get(q.id);if(!update)return q;
    if(['stemMarkdown','answerMarkdown','explanationMarkdown','type'].some(key=>q[key as keyof Question]!==update.before[key as keyof Question])){customSnapshotsSkipped++;return q;}
    const next=illustrateMusicQuestion(q,illustrations) as Question;changed=changed||JSON.stringify(next)!==JSON.stringify(q);return next;});
   if(changed){store.put('papers',paper.id,{...paper,snapshot,version:paper.version+1,updatedAt:nextStamp(paper.updatedAt)});paperVersions.push({id:paper.id,before:paper.version,after:paper.version+1});}
  }
  for(const table of protectedTables)if(digest(store,table)!==before.get(table))throw Error('Protected record changed: '+table);
  return{questions:updates.size,addedAssets,paperVersions,customSnapshotsSkipped,learningAndHistoricalAttemptsUnchanged:true};
 });
}
async function main(){
 const root=resolve(import.meta.dirname,'../../..'),database=join(root,'data/noetic-atlas.sqlite'),output=join(root,'test-results/music-notation');await mkdir(output,{recursive:true});
 const diagrams=JSON.parse(await readFile(join(root,'data/content-sources/music-notation/diagrams.json'),'utf8')),pack=JSON.parse(await readFile(join(root,'data/content-packs/knowledge-expansion-20261026-music.json'),'utf8')),ids=new Set<string>(pack.questions.map((q:Question)=>q.id));
 const apply=process.argv.includes('--apply'),backup=join(apply?join(root,'data/backups'):output,`before-music-illustrations-${Date.now()}.sqlite`);await mkdir(dirname(backup),{recursive:true});const connection=new DatabaseConnection(database,false);try{await connection.backupTo(backup);}finally{connection.close();}
 const temporary=apply?join(output,`preflight-${Date.now()}.sqlite`):backup;if(apply)await copyFile(backup,temporary);const preview=new Store(temporary);let preflight;try{preflight=applyMusicIllustrations(preview,diagrams,ids);}finally{preview.db.close();}
 if(apply)await unlink(temporary);let result=preflight;
 if(apply){const store=new Store(database);try{result=applyMusicIllustrations(store,diagrams,ids);}finally{store.db.close();}}else await unlink(temporary);
 const report={at:new Date().toISOString(),mode:apply?'apply':'dry-run',backup:apply?backup:undefined,...result};await writeFile(join(output,'apply-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
