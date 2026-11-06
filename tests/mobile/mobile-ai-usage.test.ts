import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import type { DurableStorage } from '../../mobile/runtime.ts';
import type { SQLiteRecoveryBackup } from '../../shared/models/sqlite-restore.ts';
import { reportedTokenUsage, attemptAiUsage } from '../../shared/ai/usage.js';

test('Android SQLite backup and full restore preserve complete, partial and unknown AI usage safely', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let durable: Uint8Array | undefined;
  let recovery: Uint8Array | undefined;
  let latest: SQLiteRecoveryBackup | undefined;
  const storage: DurableStorage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes) {
      durable = bytes.slice();
    },
    async createRecoveryBackup(bytes) {
      recovery = bytes.slice();
      latest = {
        id: 'usage-recovery',
        createdAt: '2026-11-06T00:00:00Z',
        byteLength: bytes.length,
      };
      return latest;
    },
    async loadRecoveryBackup() {
      return recovery!.slice();
    },
    async latestRecoveryBackup() {
      return latest;
    },
  };
  const seed = {
    schemaVersion: 1,
    domains: [],
    categories: [],
    tags: [],
    questions: [],
    questionBanks: [],
    documents: [],
    papers: [],
  };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  t.after(async () => runtime.close());
  await runtime.close();
  const complete = reportedTokenUsage({ input_tokens: 10, output_tokens: 3, total_tokens: 13 })!;
  const partial = reportedTokenUsage({ input_tokens: 5 })!;
  const stamp = '2026-11-06T00:00:00Z';
  const diagnostics = (usage: typeof complete, final: boolean) => ({
    startedAt: stamp,
    finishedAt: stamp,
    durationMs: 0,
    stage: 'validated',
    provider: 'https://fixture.invalid',
    providerCalls: 1,
    inputBytes: 30,
    outputBytes: 15,
    usage: attemptAiUsage(usage, final),
    attempts: [
      {
        index: 1,
        startedAt: stamp,
        finishedAt: stamp,
        durationMs: 0,
        phase: 'validated',
        inputBytes: 30,
        outputBytes: 15,
        status: 'completed',
        usage,
        usageFinal: final,
      },
    ],
  });
  const records = [
    {
      id: 'native-usage-complete',
      kind: 'connection_test',
      status: 'completed',
      createdAt: stamp,
      model: 'usage-model',
      warnings: [],
      questionIds: [],
      _context: { questionVersions: {}, sourceByItem: {} },
      result: { ok: true, model: 'usage-model', message: 'connected' },
      diagnostics: diagnostics(complete, true),
    },
    {
      id: 'native-usage-partial',
      kind: 'connection_test',
      status: 'completed',
      createdAt: stamp,
      model: 'usage-model',
      warnings: [],
      questionIds: [],
      _context: { questionVersions: {}, sourceByItem: {} },
      result: { ok: true, model: 'usage-model', message: 'connected' },
      diagnostics: diagnostics(partial, false),
    },
    {
      id: 'native-usage-unknown',
      kind: 'connection_test',
      status: 'completed',
      createdAt: stamp,
      model: 'usage-model',
      warnings: [],
      questionIds: [],
      _context: { questionVersions: {}, sourceByItem: {} },
      result: { ok: true, model: 'usage-model', message: 'legacy' },
    },
  ];
  const source = new sql.Database(durable);
  try {
    for (const record of records)
      source.run('INSERT INTO ai_runs(id,data) VALUES (?,?)', [record.id, JSON.stringify(record)]);
    durable = source.export();
  } finally {
    source.close();
  }
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  const backup = await runtime.fetch('/api/backup.sqlite');
  assert.equal(backup.status, 200);
  const bytes = new Uint8Array(await backup.arrayBuffer());
  const preview = await runtime.previewRestore(bytes, 'usage.sqlite');
  assert.equal(preview.counts.ai_runs, 3);
  await runtime.restore(preview.token);
  assert.ok(recovery);
  const restored = new sql.Database(durable);
  try {
    const rows = restored
      .exec('SELECT data FROM ai_runs ORDER BY id')[0]
      .values.map((row) => JSON.parse(String(row[0])));
    assert.equal(rows.length, 3);
    assert.equal(rows[0].diagnostics.usage.totalTokens, 13);
    assert.equal(rows[0].diagnostics.usage.status, 'complete');
    assert.equal(rows[1].diagnostics.usage.totalTokens, null);
    assert.equal(rows[1].diagnostics.usage.status, 'partial');
    assert.equal(rows[2].diagnostics, undefined);
  } finally {
    restored.close();
  }
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  const untouched = durable!.slice(),
    tampered = new sql.Database(durable);
  let invalid: Uint8Array;
  try {
    const value = structuredClone(records[0]);
    (value.diagnostics!.usage as Record<string, unknown>).privateKey =
      'DO_NOT_ACCEPT_OPAQUE_FIELDS';
    tampered.run('UPDATE ai_runs SET data=? WHERE id=?', [JSON.stringify(value), value.id]);
    invalid = tampered.export();
  } finally {
    tampered.close();
  }
  await assert.rejects(runtime.previewRestore(invalid!, 'invalid-usage.sqlite'));
  assert.deepEqual(durable, untouched);
});
