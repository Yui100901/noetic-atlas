/** Read-only full-bank audit. No model calls, publication or answer changes. */
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {DatabaseConnection} from '../../server/database/connection.js';
import {inspectQuestionQuality} from '../../server/modules/content-quality/rules.js';
import {normalizeQuestionBlankStems} from '../../shared/questions/blank-markers.js';
import type {Question} from '../../shared/models/types.js';

const database=resolve(process.argv[2]||'data/noetic-atlas.sqlite');
const output=resolve(process.argv[3]||'test-results/content-quality/pre-audit.json');
const db=new DatabaseConnection(database,false);
try{
  const ruleCounts:Record<string,number>={},statuses:Record<string,number>={},types:Record<string,number>={},samples:Record<string,unknown[]>={};
  let count=0,formatChanges=0,cursor:string|undefined;
  while(true){
    let query=db.query.selectFrom('questions').select(['id','data']).orderBy('id').limit(200);
    if(cursor)query=query.where('id','>',cursor);
    const rows=db.all(query);if(!rows.length)break;
    for(const row of rows){
      const q=JSON.parse(row.data) as Question;cursor=row.id;count++;
      statuses[q.status]=(statuses[q.status]||0)+1;types[q.type]=(types[q.type]||0)+1;
      if(JSON.stringify(q)!==JSON.stringify(normalizeQuestionBlankStems(q)))formatChanges++;
      for(const finding of inspectQuestionQuality(q)){
        ruleCounts[finding.rule]=(ruleCounts[finding.rule]||0)+1;
        if((samples[finding.rule]||=[]).length<30)samples[finding.rule].push({id:q.id,title:q.title,...finding});
      }
    }
  }
  const report={at:new Date().toISOString(),count,statuses,types,formatChanges,ruleCounts,samples,limitations:'Deterministic structure/editorial checks only. Full duplicate comparison uses the content-quality workbench; semantic source verification is separate.'};
  mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({count,statuses,types,formatChanges,ruleCounts,output}));
}finally{db.close();}
