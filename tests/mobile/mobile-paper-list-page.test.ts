import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native WASM paper paging and metadata stay page-local and survive restart with legacy projections', async t => {


  const {createLocalRuntime}=await loadNativeRuntime(),sql=await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
  let durable:Uint8Array|undefined,saves=0;const storage={async load(){return durable?.slice();},async save(bytes:Uint8Array){durable=bytes.slice();saves++;}};
  const seed={schemaVersion:1,domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]};let runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});t.after(()=>runtime.close());
  const api=async(url:string,method='GET',body?:unknown,status=200)=>{const response=await runtime.fetch(url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result as any;};
  await api('/api/domains','POST',{id:'native-domain',name:'原生领域'},201);
  const question=await api('/api/questions','POST',{id:'NATIVE-PAGE-Q',title:'原生题集题目',type:'short_answer',stemMarkdown:'原生分页的题干不可出现在卡片。',answerMarkdown:'PRIVATE_NATIVE_ANSWER'},201);
  await api('/api/questions/review','POST',{confirmed:true,ids:[question.id],action:'approve',expectedUpdatedAt:{[question.id]:question.updatedAt}});
  const papers=[];for(let index=0;index<25;index++)papers.push(await api('/api/papers','POST',{title:'ÉCOLE %_ '+index,description:'原生分页目录',mode:'manual',organization:index%2?'domain':'other',domainId:index%2?'native-domain':null,questionIds:[question.id],scoring:{enabled:false}},201));
  await api('/api/papers/'+papers[0].id,'DELETE');
  const baselineSaves=saves,page=await api('/api/papers/page?page=2&pageSize=10');assert.equal(page.total,24);assert.equal(page.items.length,10);assert.equal(page.page,2);assert.equal(saves,baselineSaves);
  assert.doesNotMatch(JSON.stringify(page),/PRIVATE_NATIVE_ANSWER|questionIds|questionPoints|snapshot|原生分页的题干/);
  const search=await api('/api/papers/page?search='+encodeURIComponent('école %_')+'&organization=domain&domainId=native-domain');assert.equal(search.total,12);
  const metadata=await api('/api/papers/'+papers[0].id+'/metadata');assert.deepEqual(metadata,{id:papers[0].id,title:papers[0].title,archived:true,version:1});
  const old=durable!.slice();await runtime.close();
  // A pre-change SQLite has no new derived indexes; initialization adds them
  // without touching canonical snapshots, and queries still return the page.
  const legacy=new sql.Database(old);legacy.run('DROP INDEX IF EXISTS paper_read_active_updated_idx');legacy.run('DROP INDEX IF EXISTS paper_read_domain_updated_idx');durable=legacy.export();legacy.close();
  runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});const reopened=await api('/api/papers/page?page=2&pageSize=10');assert.deepEqual(reopened,page);
  const full=await api('/api/papers/'+papers[0].id);assert.equal(full.questions[0].stemMarkdown,'原生分页的题干不可出现在卡片。');
  const empty=await api('/api/papers/page?search='+encodeURIComponent("' OR 1=1 --"));assert.equal(empty.total,0);
  const last=await api('/api/papers/page?page=999&pageSize=10');assert.equal(last.page,3);assert.equal(last.items.length,4);
  await api('/api/papers/no-such-paper/metadata','GET',undefined,404);
});
