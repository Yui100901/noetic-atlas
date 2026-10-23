import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { buildApp } from '../../server/index.js';
import config from '../../vite.config.js';

test('development proxy preserves browser host for same-origin API writes and rejects foreign origins',async t=>{
  const app=await buildApp({databasePath:':memory:',seedPath:'missing-proxy-test-seed',staticRoot:'missing-proxy-test-static'});
  const target=await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close());
  const vite=await createServer({...config,configFile:false,server:{...config.server,port:0,proxy:{'/api':{...config.server.proxy['/api'],target}}},optimizeDeps:{noDiscovery:true,include:[]}});
  await vite.listen();t.after(()=>vite.close());
  const address=vite.httpServer!.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  const valid=await fetch(`${origin}/api/exams/sync`,{method:'POST',headers:{Origin:origin}});assert.equal(valid.status,200,await valid.text());
  const foreign=await fetch(`${origin}/api/exams/sync`,{method:'POST',headers:{Origin:'https://untrusted.example'}});assert.equal(foreign.status,403);assert.equal((await foreign.json() as any).error.code,'CROSS_ORIGIN_REJECTED');
});
