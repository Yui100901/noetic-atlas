/** Read-only localhost profiling; records timings/byte counts, never response data. */
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const base=new URL(option('--url','http://127.0.0.1:4317'));
if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw Error('Only an explicitly local API may be profiled');
const output=resolve(option('--out','test-results/performance/http-after.json')),runs=Number(option('--runs','5'));
if(!Number.isInteger(runs)||runs<1||runs>30)throw Error('runs must be 1–30');
const paths=['/api/health','/api/bootstrap','/api/questions?pageSize=30','/api/questions?pageSize=30&domainId=chemistry','/api/questions?pageSize=30&search=transaction','/api/question-banks?page=1&pageSize=20','/api/papers?page=1&pageSize=20','/api/papers?archived=true&page=1&pageSize=20','/api/documents?page=1&pageSize=20','/api/exams/active','/api/vocabulary?word=learn',...args.includes('--assets')?['/api/assets?page=1&pageSize=20']:[]];
const results=[];
for(const path of paths){
  const ms=[];let bytes=0;
  for(let i=0;i<runs;i++){const start=performance.now(),response=await fetch(new URL(path,base),{signal:AbortSignal.timeout(30000)});const body=await response.arrayBuffer();if(!response.ok)throw Error(`${path}: HTTP ${response.status}`);ms.push(Math.round((performance.now()-start)*10)/10);bytes=body.byteLength;}
  const sorted=[...ms].sort((a,b)=>a-b),row={path,ms,medianMs:sorted[Math.floor(sorted.length/2)],bytes};results.push(row);console.log(JSON.stringify(row));
}
await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify({createdAt:new Date().toISOString(),origin:base.origin,readOnly:true,runs,results},null,2)+'\n');
