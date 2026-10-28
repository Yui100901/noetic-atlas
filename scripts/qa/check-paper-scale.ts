/** Synthetic, isolated scale check. Never opens an installation database. */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../../server/core/store.js';
import { parse, questionSchema } from '../../server/core/validation.js';
import { paperListPageQuery, paperListPageQuerySchema } from '../../server/modules/practice/paper-list.js';
import { registerPracticeRoutes } from '../../server/modules/practice/routes.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import type { StoredPaper } from '../../server/modules/practice/service.js';

const count = Number(process.env.PAPER_SCALE_COUNT || 5000), members = Number(process.env.PAPER_SCALE_MEMBERS || 25);
assert.ok(Number.isSafeInteger(count) && count >= 100 && count <= 20000);
assert.ok(Number.isSafeInteger(members) && members >= 1 && members <= 500);
const output = resolve('test-results/paper-scale'); await mkdir(output, { recursive: true });
const store = new Store(':memory:'), app = Fastify({ logger: false }); registerPracticeRoutes(app, store);
app.addHook('onClose', async () => store.db.close());
try {
  const seedStart = performance.now(),stamp = '2026-10-28T00:00:00.000Z';
  const snapshot = Array.from({length:members},(_,index)=>parse(questionSchema,{id:'Q'+index,title:'事务概念'+index,type:index%2?'short_answer':'true_false',stemMarkdown:'合成测试原题干，不是真实学习数据。'.repeat(30),answerMarkdown:'答案完整保存在题集快照。'.repeat(20),correctAnswers:index%2?[]:['true'],status:'published'}));
  const scoring = normalizeScoring(snapshot,{enabled:false});
  store.transaction(()=>{for(let index=0;index<count;index++){
    const id='SCALE-'+String(index).padStart(6,'0'),paper:StoredPaper={id,title:`规模基准 ${index%3?'计算机':'日常知识'} ${index}`,description:'合成目录说明，列表不传输完整快照。'.repeat(70),mode:'manual',questionIds:snapshot.map(q=>q.id),questionCount:members,snapshot,filters:null,scoring,archived:index%100===0,version:1,createdAt:stamp,updatedAt:new Date(Date.parse(stamp)+index*1000).toISOString(),organization:index%3?'domain':'other',domainId:index%3?'computer':null};
    store.put('papers',id,paper);
  }});
  const seedMs = performance.now()-seedStart;
  const projectionStart=performance.now(); store.database.projections.ensure(['papers']); const projectionRefreshMs=performance.now()-projectionStart;
  const timed=async(url:string)=>{const start=performance.now(),response=await app.inject(url);assert.equal(response.statusCode,200,response.body);const durationMs=performance.now()-start;return{durationMs:Number(durationMs.toFixed(3)),bytes:Buffer.byteLength(response.body),value:response.json()};};
  // Warm both paths before reporting repeated samples. Cold projection work is
  // reported separately rather than counted on only one side of the comparison.
  await timed('/api/papers');await timed('/api/papers/page?page=1&pageSize=20');
  const previous=[],paged=[],domain=[],deep=[];
  for(let round=0;round<5;round++){
    previous.push(await timed('/api/papers'));
    paged.push(await timed('/api/papers/page?page=1&pageSize=20'));
    domain.push(await timed('/api/papers/page?organization=domain&domainId=computer&pageSize=20'));
    deep.push(await timed('/api/papers/page?page=200&pageSize=20'));
  }
  const old=previous[0]!,page=paged[0]!;assert.equal(page.value.total,old.value.length);assert.equal(page.value.items.length,20);assert.deepEqual(page.value.items.map((item:any)=>item.id),old.value.slice(0,20).map((item:any)=>item.id));
  for(const item of page.value.items)for(const key of ['snapshot','questions','questionIds','filters'])assert.ok(!Object.hasOwn(item,key));
  assert.ok(!Object.hasOwn(page.value.items[0].scoring,'questionPoints'));
  const query=paperListPageQuery(store,parse(paperListPageQuerySchema,{organization:'domain',domainId:'computer'}));
  const plan=store.database.explain(query.clearSelect().clearOrderBy().select(eb=>eb.fn.countAll<number>().as('count')));
  const activeQuery=paperListPageQuery(store,parse(paperListPageQuerySchema,{}));
  const activePlan=store.database.explain(activeQuery.clearSelect().select('p.id').limit(20));
  assert.ok(plan.some((row:any)=>String(row.detail).includes('paper_read_domain_updated_idx')));
  const stats=(values:typeof paged)=>{const sorted=values.map(item=>item.durationMs).sort((a,b)=>a-b);return{rounds:values.length,medianMs:sorted[Math.floor(sorted.length/2)],maxMs:sorted.at(-1),bytes:values[0]!.bytes};};
  const oldStats=stats(previous),newStats=stats(paged);
  const report={isolated:true,databasePath:':memory:',papers:count,membersPerPaper:members,seedMs:Number(seedMs.toFixed(3)),projectionRefreshMs:Number(projectionRefreshMs.toFixed(3)),unpaged:oldStats,cardPage20:newStats,domainPage20:stats(domain),deepPage200:stats(deep),payloadReductionPercent:Number(((1-newStats.bytes/oldStats.bytes)*100).toFixed(3)),queryPlan:plan,activePageQueryPlan:activePlan,note:'Synthetic warm in-process HTTP timings, not production network latency. Both paths warm projections first. No hard elapsed-time assertion.'};
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally { await app.close(); }
