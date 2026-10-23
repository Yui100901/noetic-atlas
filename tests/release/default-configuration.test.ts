import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { DEFAULT_AI_SETTINGS } from '../../shared/ai/ai.js';
import { configurationSchema } from '../../server/modules/settings/configuration.js';
import { buildApp } from '../../server/index.js';
// @ts-expect-error Build scripts use plain JavaScript.
import { validateBaseConfiguration } from '../../scripts/release/validate-public-data.mjs';

test('release base configuration rejects opaque credentials and private fields even with checks skipped',()=>{
  const clean=()=>JSON.parse(readFileSync('config/defaults.json','utf8'));
  assert.equal(validateBaseConfiguration(clean()).credentials,false);
  for(const mutate of [
    (data:any)=>{data.ai.key='opaque-token';},
    (data:any)=>{data.ai.baseUrl='https://private-provider.example';},
    (data:any)=>{data.system.notes='private preferences';},
    (data:any)=>{data.system.maxHistoryPerPaper='opaque-secret';},
    (data:any)=>{data.questions=[];},
  ]){const data=clean();mutate(data);assert.throws(()=>validateBaseConfiguration(data));}
});

test('published base configuration matches code defaults and imports into an empty installation without content',async t=>{
  const data=configurationSchema.parse(JSON.parse(readFileSync('config/defaults.json','utf8')));
  const {id:_id,updatedAt:_time,...system}=DEFAULT_SETTINGS;
  const {hasKey:_hasKey,updatedAt:_aiTime,...ai}=DEFAULT_AI_SETTINGS;
  assert.deepEqual(data.system,system);assert.deepEqual(data.ai,ai);
  assert.equal(data.ai?.enabled,false);assert.equal(data.ai?.baseUrl,'');
  const app=await buildApp({databasePath:':memory:',staticRoot:'test-results/no-default-configuration-web'});
  t.after(()=>app.close());
  const preview=await app.inject({method:'POST',url:'/api/settings/import/preview',payload:{data}});
  assert.equal(preview.statusCode,200);const plan=preview.json();
  assert.deepEqual(plan.systemChanges,[]);assert.deepEqual(plan.aiChanges,[]);assert.equal(plan.retention.total,0);
  assert.equal((await app.inject({method:'POST',url:'/api/settings/import',payload:{data,fingerprint:plan.fingerprint,confirmed:true}})).statusCode,200);
  const bootstrap=(await app.inject('/api/bootstrap')).json();
  assert.equal(bootstrap.stats.totalQuestions,0);assert.deepEqual(bootstrap.domains,[]);assert.deepEqual(bootstrap.tags,[]);
});
