import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native AI workspace drafts persist, roll back disk failures and pass full SQLite recovery validation',async t=>{


 const {createLocalRuntime}=await loadNativeRuntime(),sql=await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
 const seed={schemaVersion:1,domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]};
 let durable:Uint8Array|undefined,failSave=false,saves=0;
 const storage={async load(){return durable?.slice();},async save(bytes:Uint8Array){if(failSave)throw new Error('test disk full');durable=bytes.slice();saves++;}};
 let runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});t.after(()=>runtime.close());
 const api=async(url:string,method='GET',body?:unknown,status=200)=>{const response=await runtime.fetch(url,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result as any;};
 let draft=await api('/api/ai/workspace-drafts','POST',{kind:'documents',contextId:null,state:{sourceName:'已提取的教材',local:{sourceName:'demo.txt',sections:[{text:'尚未创建任务的私有教材',sourceName:'demo.txt',label:'概念'}],characters:14,bytes:42,files:1,pages:0,warnings:[]}}},201);
 await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});assert.equal((await api('/api/ai/workspace-drafts?kind=documents'))[0].state.local.sections[0].text,'尚未创建任务的私有教材');
 const before=durable!.slice(),readSaves=saves;await api('/api/ai/workspace-drafts?kind=documents');assert.equal(saves,readSaves);
 failSave=true;await api(`/api/ai/workspace-drafts/${draft.id}`,'PUT',{expectedUpdatedAt:draft.updatedAt,state:{sourceName:'不应写入'}},507);assert.deepEqual(durable,before);failSave=false;
 const previous=draft;draft=await api(`/api/ai/workspace-drafts/${draft.id}`,'PUT',{expectedUpdatedAt:draft.updatedAt,state:{sourceName:'同一份草稿继续',local:null}});assert.equal(draft.id,previous.id);
 await api(`/api/ai/workspace-drafts/${draft.id}`,'PUT',{expectedUpdatedAt:previous.updatedAt,state:{}},409);
 const preview=await runtime.previewRestore(durable!.slice(),'workspace.sqlite');assert.equal(preview.counts.ai_workspace_drafts,1);
 const bad=new sql.Database(durable!),invalid={...draft,state:{apiKey:'MUST_NOT_RESTORE'}};bad.run('UPDATE ai_workspace_drafts SET data=? WHERE id=?',[JSON.stringify(invalid),draft.id]);const badBytes=bad.export();bad.close();
 const stable=durable!.slice();await assert.rejects(runtime.previewRestore(badBytes,'invalid.sqlite'),/输入数据不符合约定/);assert.deepEqual(durable,stable);assert.equal((await api('/api/ai/workspace-drafts?kind=documents'))[0].state.sourceName,'同一份草稿继续');
 const exported=await api('/api/export');assert.equal(exported.aiWorkspaceDrafts[0].id,draft.id);
 // Old SQLite files are upgraded durably even before the AI workspace opens.
 await runtime.close();const old=new sql.Database(durable!);old.run('DROP TABLE ai_workspace_drafts');durable=old.export();old.close();const oldSaves=saves;
 runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});assert.ok(saves>oldSaves);assert.deepEqual(await api('/api/ai/workspace-drafts?kind=documents'),[]);
});
