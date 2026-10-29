import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { createEmptyInitialData } from '../../shared/models/initial-data.js';

test('mobile configuration migration is empty by default, private and durably atomic',async t=>{


  const {createLocalRuntime}=await loadNativeRuntime();
  const sql=await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
  let durable:Uint8Array|undefined,failSave=false,writes=0;
  const storage={async load(){return durable?.slice();},async save(bytes:Uint8Array){if(failSave)throw Error('disk full');writes++;durable=bytes.slice();}};
  let runtime=await createLocalRuntime(sql,createEmptyInitialData(),storage);t.after(()=>runtime.close());
  const api=async(path:string,method='GET',body?:unknown,status=200):Promise<any>=>{
    const response=await runtime.fetch(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;
  };
  const defaults=JSON.parse(await readFile('config/defaults.json','utf8'));
  await t.test('native route body limits count UTF-8 bytes before parsing large configuration data',async()=>{
    await api('/api/settings/import/preview','POST',{data:{...defaults,unknown:'汉'.repeat(400_000)}},413);
  });
  await t.test('empty mobile installation exports clean defaults and preview never persists a write',async()=>{
    assert.equal((await api('/api/bootstrap')).stats.totalQuestions,0);
    const exported=await api('/api/settings/export');assert.deepEqual(exported.system,defaults.system);assert.deepEqual(exported.ai,defaults.ai);
    const before=writes;failSave=true;
    try{await api('/api/settings/import/preview','POST',{data:defaults});}finally{failSave=false;}
    assert.equal(writes,before);
  });
  await t.test('a failed persistent import rolls both configurations back without losing the local key',async()=>{
    const old=await api('/api/ai/settings');await api('/api/ai/settings','PUT',{...defaults.ai,enabled:true,baseUrl:'https://example.org/old',model:'test',key:'native-test-key',updatedAt:old.updatedAt});
    const incoming={...defaults,system:{...defaults.system,maxDraftsPerPaper:8},ai:{...defaults.ai,enabled:true,baseUrl:'https://example.org/new',model:'test'}};
    const before=await api('/api/settings'),bytes=durable!.slice();const preview=await api('/api/settings/import/preview','POST',{data:incoming});
    assert.equal(preview.aiKey.action,'clear');failSave=true;
    await api('/api/settings/import','POST',{data:incoming,fingerprint:preview.fingerprint,confirmed:true},507);failSave=false;
    assert.deepEqual(durable,bytes);assert.deepEqual(await api('/api/settings'),before);assert.equal((await api('/api/ai/settings')).hasKey,true);
    const retry=await api('/api/settings/import/preview','POST',{data:incoming});await api('/api/settings/import','POST',{data:incoming,fingerprint:retry.fingerprint,confirmed:true});
    assert.equal((await api('/api/settings')).maxDraftsPerPaper,8);assert.equal((await api('/api/ai/settings')).hasKey,false);
  });
  await t.test('preferences survive reopen without importing question data or exposing credentials',async()=>{
    await runtime.close();runtime=await createLocalRuntime(sql,createEmptyInitialData(),storage);
    const exported=await api('/api/settings/export');assert.equal(exported.system.maxDraftsPerPaper,8);
    assert.ok(!JSON.stringify(exported).includes('native-test-key'));assert.ok(!('questions'in exported));
    const bootstrap=await api('/api/bootstrap');assert.equal(bootstrap.stats.totalQuestions,0);assert.deepEqual(bootstrap.domains,[]);
  });
});
