import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { learningSeed } from '../fixtures/learning-seed.js';
import { readDataPackage } from '../../shared/packages/data-package.js';

test('native batch and special-set sharing keep complete content without writing source state', async () => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const SQL = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let saved: Uint8Array | undefined,
    writes = 0;
  const runtime = await createLocalRuntime(
    SQL,
    learningSeed(),
    {
      load: async () => saved?.slice(),
      save: async (bytes) => {
        saved = bytes.slice();
        writes++;
      },
    },
    { dailyPushScheduler: false },
  );
  const api = async (url: string, method = 'GET', data?: unknown) => {
    const response = await runtime.fetch(url, {
      method,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    for (let i = 0; i < 2; i++)
      await api('/api/papers', 'POST', {
        title: '原生题集 ' + i,
        mode: 'manual',
        questionIds: ['FIXTURE-BOOL'],
        scoring: { enabled: false },
      });
    await api('/api/study/FIXTURE-BOOL', 'PUT', { favorite: true, notes: 'NATIVE_PRIVATE_NOTE' });
    const baseline = writes;
    const selection = { kind: 'paper', filters: { search: '原生题集' } };
    assert.equal(
      (await api('/api/packages/export-preview', 'POST', { kind: 'share', selection })).allowed,
      true,
    );
    const download = await api('/api/packages/export', 'POST', { kind: 'share', selection });
    const packet = await readDataPackage(Buffer.from(download.dataBase64, 'base64'));
    assert.equal((packet.payloads[0]!.data as any).papers.length, 2);
    assert.equal((packet.payloads[0]!.data as any).questions.length, 1);
    const favorite = await api('/api/packages/export', 'POST', {
      kind: 'share',
      selection: { kind: 'learning', learning: { kind: 'favorite' } },
    });
    const content = await readDataPackage(Buffer.from(favorite.dataBase64, 'base64'));
    assert.equal((content.payloads[0]!.data as any).questions.length, 1);
    assert.ok(!JSON.stringify(content.payloads).includes('NATIVE_PRIVATE_NOTE'));
    assert.equal(writes, baseline);
  } finally {
    await runtime.close();
  }
});
