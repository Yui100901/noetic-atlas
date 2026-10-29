/** Isolated library transfer/query benchmark; never opens installation data. */
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store } from '../../server/core/store.js';
import { registerLibraryRoutes } from '../../server/modules/library/routes.js';

const count = Number(process.env.LIBRARY_SCALE_COUNT || 1000);
assert.ok(Number.isInteger(count) && count >= 100 && count <= 5000);
const folder = resolve('test-results/library-scale'); await mkdir(folder, { recursive: true });
const store = new Store(':memory:'), app = Fastify({ logger: false }); registerLibraryRoutes(app, store);
app.addHook('onClose', async () => store.db.close());
try {
  const body = '# Synthetic textbook\n' + '教材解释事务的原子性及隔离边界，不是真实数据。'.repeat(2000) + 'BODY_TAIL_CANARY';
  store.transaction(() => {
    for (let index = 0; index < count; index++) store.put('documents', 'BOOK-' + index, {
      id: 'BOOK-' + index, title: 'ÉCOLE synthetic textbook ' + index, kind: '书籍', bodyMarkdown: body, collection: 'general', categoryIds: [], tagIds: [], sourcePath: null,
      author: '合成作者', description: '', updatedAt: new Date(Date.UTC(2026, 9, 29) + index * 1000).toISOString(),
    });
  });
  const projectionStarted = performance.now(); store.database.projections.ensure(['documents']);
  const projectionRefreshMs = Number((performance.now() - projectionStarted).toFixed(3));
  const timed = async (url: string) => {
    const start = performance.now(), reply = await app.inject(url); assert.equal(reply.statusCode, 200, reply.body);
    return { ms: performance.now() - start, bytes: Buffer.byteLength(reply.body), result: reply.json() };
  };
  await timed('/api/documents?page=1&pageSize=20'); await timed('/api/documents/page?page=1&pageSize=20');
  const full = [], cards = [], search = [];
  for (let index = 0; index < 5; index++) {
    full.push(await timed('/api/documents?page=1&pageSize=20'));
    cards.push(await timed('/api/documents/page?page=1&pageSize=20'));
    search.push(await timed('/api/documents/page?search=body_tail_canary&pageSize=20'));
  }
  assert.deepEqual(full[0]!.result.items.map((item: any) => item.id), cards[0]!.result.items.map((item: any) => item.id));
  assert.equal(search[0]!.result.total, count); assert.doesNotMatch(JSON.stringify(cards[0]!.result), /BODY_TAIL_CANARY|bodyMarkdown/);
  const summarize = (samples: typeof full) => { const times = samples.map(item => item.ms).sort((a,b) => a-b); return { medianMs: Number(times[2]!.toFixed(3)), maxMs: Number(times.at(-1)!.toFixed(3)), bytes: samples[0]!.bytes }; };
  const report = { isolated: true, books: count, bodyBytesPerBook: Buffer.byteLength(body), projectionRefreshMs, fullBodyPage20: summarize(full), metadataPage20: summarize(cards), bodySearchPage20: summarize(search),
    payloadReductionPercent: Number(((1 - cards[0]!.bytes / full[0]!.bytes) * 100).toFixed(3)),
    note: 'Synthetic in-memory warm HTTP timings. Full-body API is retained; the UI uses metadata pages. Search scans the versioned raw-lowercase projection inside the driver. First projection work is reported separately. No hard timing assertions.' };
  await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
