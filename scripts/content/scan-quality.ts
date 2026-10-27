/** Explicit persisted batch scan. No AI/network calls or content corrections. */
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {Store} from '../../server/core/store.js';
import {recordTables,type RecordTable} from '../../server/database/schema.js';
import {createQualityScan,processQualityScan,qualityOverview,requireQualityScan} from '../../server/modules/content-quality/service.js';

const args=process.argv.slice(2),value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
const path=resolve(value('--database')||'data/noetic-atlas.sqlite'),output=resolve(value('--report')||'test-results/content-quality/full-scan.json');
if(!existsSync(path))throw Error('Existing database required.');
const store=new Store(path);
const digest=(table:RecordTable)=>{const hash=createHash('sha256');let cursor:string|undefined;while(true){let query=store.database.query.selectFrom(table).select(['id','data']).orderBy('id').limit(table==='assets'?1:200);if(cursor)query=query.where('id','>',cursor);const rows=store.database.all(query);if(!rows.length)break;for(const row of rows){hash.update(JSON.stringify([row.id,row.data]));cursor=row.id;}}return hash.digest('hex');};
try{
 const protectedTables=recordTables.filter(table=>!['quality_scans','quality_issues','quality_fingerprints'].includes(table));
 const before=new Map(protectedTables.map(table=>[table,digest(table)]));
 let scan=value('--resume')?requireQualityScan(store,value('--resume')!):createQualityScan(store,{status:'all'});
 console.log(JSON.stringify({scanId:scan.id,planned:scan.plannedTotal,processed:scan.processed}));
 let batch=0;
 while(['ready','failed'].includes(scan.status)){scan=processQualityScan(store,scan.id,200);if(++batch%10===0||scan.status==='completed')console.log(JSON.stringify({processed:scan.processed,total:scan.plannedTotal,findings:scan.findings,status:scan.status}));await new Promise<void>(done=>setImmediate(done));}
 for(const table of protectedTables)if(digest(table)!==before.get(table))throw Error('Scan unexpectedly modified source or learning table: '+table);
 const d=store.database,x=d.expressions;
 const ruleCounts=d.all(d.query.selectFrom('quality_issues').select([x.field<string>('data','rule').as('rule'),x.field<string>('data','status').as('status')]).select(eb=>eb.fn.countAll<number>().as('count')).groupBy([x.field('data','rule'),x.field('data','status')]));
 const report={at:new Date().toISOString(),scan,overview:qualityOverview(store),issueCounts:ruleCounts,sourceAndLearningRecordsUnchanged:true};await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:output,scanId:scan.id,processed:scan.processed,findings:scan.findings,ruleCounts:scan.ruleCounts,sourceAndLearningRecordsUnchanged:true}));
}finally{store.db.close();}
