/** Explicit quality-policy upgrade with an independent backup and preflight.
 * No question content, publication, learning, assets or AI settings are changed. */
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,copyFile,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../../server/core/store.js';
import {DatabaseConnection} from '../../server/database/connection.js';
import {recordTables,type RecordTable} from '../../server/database/schema.js';
import {retireMissingSourceIssues,retireMissingExplanationIssues} from '../../server/modules/content-quality/maintenance.js';
import {migrateFeedbackQualityIssues} from '../../server/modules/content-quality/feedback-links.js';
import {qualityOverview} from '../../server/modules/content-quality/service.js';
import type {QuestionFeedback} from '../../shared/models/question-feedback.js';

function digest(store:Store,table:RecordTable){const hash=createHash('sha256');let cursor:string|undefined;while(true){let query=store.database.query.selectFrom(table).select(['id','data']).orderBy('id').limit(table==='assets'?1:200);if(cursor)query=query.where('id','>',cursor);const rows=store.database.all(query);if(!rows.length)break;for(const row of rows){hash.update(JSON.stringify([row.id,row.data]));cursor=row.id;}}return hash.digest('hex');}
function feedbackEvidence(value:QuestionFeedback){const {origin:_origin,qualityIssueId:_case,...evidence}=value;return JSON.stringify(evidence);}
export function unifyQualityData(store:Store){
 return store.transaction(()=>{
  const protectedTables=recordTables.filter(table=>!['quality_issues','question_feedback'].includes(table));
  const before=new Map(protectedTables.map(table=>[table,digest(store,table)]));
  const feedbacks=store.database.records<QuestionFeedback>('question_feedback');
  const retired=retireMissingSourceIssues(store),explanations=retireMissingExplanationIssues(store),linked=migrateFeedbackQualityIssues(store);
  for(const table of protectedTables)if(before.get(table)!==digest(store,table))throw Error('Unexpected protected data change: '+table);
  // Adding links must not rewrite a previously independent human report.
  for(const original of feedbacks)if(!original.qualityIssueId){const next=store.database.getRecord<QuestionFeedback>('question_feedback',original.id);if(!next||feedbackEvidence(original)!==feedbackEvidence(next))throw Error('Original feedback evidence changed: '+original.id);}
  const overview=qualityOverview(store);
  return{removedMissingSourceIssues:retired,removedMissingExplanationIssues:explanations,feedbackLinksCreated:linked,feedbackRecords:feedbacks.length,qualityCounts:overview.counts,totalIssues:overview.totalIssues,questionAndLearningDataUnchanged:true,originalIndependentFeedbackEvidenceUnchanged:true};
 });
}
async function main(){
 const args=process.argv.slice(2),value=(flag:string)=>{const index=args.indexOf(flag);return index<0?undefined:args[index+1];},root=resolve(import.meta.dirname,'../..');
 const database=resolve(value('--database')||join(root,'data/noetic-atlas.sqlite')),folder=resolve(value('--report-folder')||join(root,'test-results/unified-quality')),apply=args.includes('--apply');if(!existsSync(database))throw Error('Existing database required');await mkdir(folder,{recursive:true});
 let backup=value('--backup');
 if(backup){backup=resolve(backup);if(!existsSync(backup))throw Error('Backup does not exist');}
 else{backup=join(root,`data/backups/before-unified-quality-${Date.now()}.sqlite`);await mkdir(dirname(backup),{recursive:true});const connection=new DatabaseConnection(database,false);try{await connection.backupTo(backup);}finally{connection.close();}}
 const previewPath=join(folder,`preflight-${Date.now()}.sqlite`);await copyFile(backup,previewPath);const preview=new Store(previewPath);let preflight;
 try{preflight=unifyQualityData(preview);}finally{preview.db.close();}await unlink(previewPath);
 let result=preflight;if(apply){const store=new Store(database);try{result=unifyQualityData(store);}finally{store.db.close();}}
 const report={at:new Date().toISOString(),mode:apply?'apply':'dry-run',backup,preflight,result};await writeFile(join(folder,'migration-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
