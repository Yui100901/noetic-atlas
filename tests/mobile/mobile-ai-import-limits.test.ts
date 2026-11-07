import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native material limits persist across restart and reject oversized task text before model work', async () => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let durable: Uint8Array | undefined;
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      durable = bytes.slice();
    },
  };
  const seed = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    domains: [],
    categories: [],
    tags: [],
    questions: [],
    documents: [],
    papers: [],
  };
  let runtime = await createLocalRuntime(sql, seed, storage);
  const api = async (url: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await runtime.fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });
    assert.equal(response.status, status, await response.clone().text());
    return response.json();
  };
  try {
    const settings = await api('/api/settings');
    assert.equal(settings.aiImport.fileMiB, 128);
    await api('/api/settings', 'PUT', {
      settings: { ...settings, aiImport: { ...settings.aiImport, sourceCharacters: 1000 } },
    });
    await runtime.close();
    runtime = await createLocalRuntime(sql, seed, storage);
    assert.equal((await api('/api/settings')).aiImport.sourceCharacters, 1000);
    const result = await api(
      '/api/ai/document-jobs',
      'POST',
      { confirmed: true, sourceName: 'native-limits', sections: [{ text: 'x'.repeat(1500) }] },
      413,
    );
    assert.equal(result.error.code, 'AI_DOCUMENT_TOO_LARGE');
    assert.equal((await api('/api/ai/document-jobs')).length, 0);
  } finally {
    await runtime.close();
  }
});
