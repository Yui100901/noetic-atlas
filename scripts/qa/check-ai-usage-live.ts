/** One optional real-provider connection request. Reads only existing settings;
 * all writes and audit records live in an isolated in-memory database. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseConnection } from '../../server/database/connection.js';
import { buildApp } from '../../server/index.js';
import type { PrivateAiSettings } from '../../server/modules/ai/provider.js';

const root = resolve(import.meta.dirname, '../..');
const source = resolve(root, 'data/noetic-atlas.sqlite');
const folder = resolve(
  root,
  'test-results/ai-usage-live',
  new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid,
);
await mkdir(folder, { recursive: true });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read() {
  assert.ok(existsSync(source), 'EXISTING_CONFIGURATION_REQUIRED');
  const database = new DatabaseConnection(source, false);
  try {
    return database.getRecord<PrivateAiSettings>('ai_settings', 'local');
  } finally {
    database.close();
  }
}
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let fingerprint: string | undefined,
  secret = '',
  calls = 0;
const originalFetch = globalThis.fetch;
const report: Record<string, unknown> = {
  ok: false,
  isolated: true,
  syntheticOnly: true,
  database: ':memory:',
  operatorServiceAccessed: false,
};
try {
  const config = read();
  assert.ok(config?.enabled && config.baseUrl && config.model, 'AI_CONFIGURATION_NOT_ENABLED');
  secret = config.key || '';
  fingerprint = hash(config);
  const endpoint = new URL(config.baseUrl);
  assert.ok(
    !(endpoint.hostname === '127.0.0.1' && endpoint.port === '4317'),
    'OPERATOR_SERVICE_FORBIDDEN',
  );
  app = await buildApp({
    databasePath: ':memory:',
    seedPath: resolve(folder, 'no-seed'),
    staticRoot: resolve(folder, 'no-web'),
    native: true,
    dailyPushScheduler: false,
  });
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    assert.ok(++calls <= 1, 'LIVE_USAGE_REQUEST_LIMIT');
    return originalFetch(...args);
  };
  const { updatedAt: _updated, ...portable } = config;
  const configured = await app.inject({
    method: 'PUT',
    url: '/api/ai/settings',
    payload: { ...portable, timeoutSeconds: Math.max(config.timeoutSeconds, 60) },
  });
  assert.equal(configured.statusCode, 200, 'ISOLATED_CONFIGURATION_REJECTED');
  const response = await app.inject({ method: 'POST', url: '/api/ai/test', payload: {} });
  if (response.statusCode !== 200) {
    const failure = response.json().error;
    const code =
      typeof failure?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(failure.code)
        ? failure.code
        : 'LIVE_REQUEST_FAILED';
    report.error = { code, status: response.statusCode };
    const history = await app.inject('/api/ai/runs?page=1&pageSize=10');
    report.failedRecords =
      history.statusCode === 200
        ? history.json().items.map((run: any) => ({
            id: run.id,
            status: run.status,
            usage: run.diagnostics?.usage,
            providerCalls: run.diagnostics?.providerCalls,
          }))
        : [];
    process.exitCode = 1;
  } else {
    const summary = await app.inject('/api/ai/usage?kind=connection_test');
    assert.equal(summary.statusCode, 200, 'USAGE_ENDPOINT_FAILED');
    const stats = summary.json();
    assert.equal(stats.runs, 1);
    assert.equal(stats.usage.calls, 1);
    const history = await app.inject('/api/ai/runs?kind=connection_test&page=1&pageSize=10');
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().total, 1);
    assert.equal(history.json().items[0].diagnostics.usage.totalTokens, stats.usage.totalTokens);
    report.model = config.model;
    report.provider = endpoint.origin;
    report.usage = stats.usage;
    report.reportedBySupplier = stats.usage.reportedCalls > 0;
    report.checks = [
      'one synthetic connection request',
      'successful connection recorded once',
      'record and aggregate usage agree',
      'missing counts remain unknown',
    ];
    report.ok = true;
  }
} catch (reason: any) {
  report.error ||= {
    code:
      typeof reason?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(reason.code)
        ? reason.code
        : 'LIVE_USAGE_CHECK_FAILED',
  };
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
  report.providerCalls = calls;
  try {
    report.workingConfigurationUnchanged =
      fingerprint !== undefined && hash(read()) === fingerprint;
  } catch {
    report.workingConfigurationUnchanged = false;
  }
  if (!report.workingConfigurationUnchanged) {
    report.ok = false;
    process.exitCode = 1;
  }
  await app?.close();
  const serialized = JSON.stringify(report, null, 2);
  const safe = secret ? serialized.replaceAll(secret, '[redacted]') : serialized;
  await writeFile(resolve(folder, 'report.json'), safe);
  console.log(safe);
}
