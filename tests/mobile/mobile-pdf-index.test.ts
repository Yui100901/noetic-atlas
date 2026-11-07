import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { PDFDocument } from 'pdf-lib';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { learningSeed } from '../fixtures/learning-seed.js';

test('Android FTS4 indexes Chinese/English, checkpoints versions, migrates and rebuilds poisoned FTS shadows safely', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime(),
    sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let durable: Uint8Array | undefined,
    saves = 0;
  const backups = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      durable = bytes.slice();
      saves++;
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = `pdf-${backups.size}`;
      backups.set(id, bytes.slice());
      return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
    },
    async loadRecoveryBackup(id: string) {
      return backups.get(id)!.slice();
    },
  };
  let runtime = await createLocalRuntime(sql, learningSeed(), storage, {
    dailyPushScheduler: false,
  });
  t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', body?: unknown, status = 200): Promise<any> => {
    const response = await runtime.fetch(url, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  };
  const newPdf = async (label: string) => {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText(label);
    return api(
      '/api/assets',
      'POST',
      {
        filename: label + '.pdf',
        mimeType: 'application/pdf',
        dataBase64: Buffer.from(await pdf.save()).toString('base64'),
      },
      201,
    );
  };
  const oldAsset = await newPdf('old'),
    newAsset = await newPdf('new');
  let document = await api(
    '/api/documents',
    'POST',
    {
      id: 'pdf-book',
      title: 'PDF教材',
      format: 'pdf',
      kind: '书籍',
      assetId: oldAsset.id,
      categoryIds: [learningSeed().categories[0]!.id],
    },
    201,
  );
  const index = async (assetId: string, text: string, partial = false) => {
    const job = (await api('/api/pdf-index/jobs')).find((value: any) => value.assetId === assetId),
      claim = await api(`/api/pdf-index/jobs/${job.id}/claim`, 'POST');
    await api(`/api/pdf-index/jobs/${job.id}/pages`, 'POST', {
      lease: claim.lease,
      pageCount: partial ? 2 : 1,
      pages: [
        {
          pageNumber: 1,
          text,
          width: 400,
          height: 500,
          items: [{ text, start: 0, end: text.length, x: 20, y: 450, width: 200, height: 12 }],
        },
      ],
      complete: !partial,
    });
    return { job, claim };
  };
  await index(oldAsset.id, '旧版术语 oldprefix opportunity');
  document = await api('/api/documents/pdf-book', 'GET');
  document = await api('/api/documents/pdf-book', 'PUT', { ...document, assetId: newAsset.id });
  const partial = await index(newAsset.id, '新版 沉 没 成 本 opportunity', true);
  await api(`/api/pdf-index/jobs/${partial.job.id}/control`, 'POST', { action: 'pause' });
  const beforeReads = saves;
  assert.equal(
    (await api(`/api/pdf-index/assets/${newAsset.id}/search?q=${encodeURIComponent('沉没成本')}`))
      .total,
    1,
  );
  assert.equal((await api('/api/search?q=opport')).counts.document, 1);
  assert.equal(saves, beforeReads, 'index reads never save the whole native DB');
  await runtime.close();
  runtime = await createLocalRuntime(sql, learningSeed(), storage, { dailyPushScheduler: false });
  await api(`/api/pdf-index/jobs/${partial.job.id}/control`, 'POST', { action: 'resume' });
  const resumed = await api(`/api/pdf-index/jobs/${partial.job.id}/claim`, 'POST');
  assert.equal(resumed.nextPage, 2);
  await api(`/api/pdf-index/jobs/${partial.job.id}/pages`, 'POST', {
    lease: resumed.lease,
    pageCount: 2,
    pages: [{ pageNumber: 2, text: '', width: 400, height: 500, items: [] }],
    complete: true,
  });
  assert.equal((await api(`/api/pdf-index/assets/${oldAsset.id}/search?q=oldpre`)).total, 1);
  assert.equal(
    (await api(`/api/pdf-index/assets/${newAsset.id}/search?q=${encodeURIComponent('沉')}`)).total,
    1,
  );
  const preview = await api('/api/migrations/preview', 'POST', {
      domainIds: [learningSeed().domains[0]!.id],
    }),
    exported = await runtime.fetch(
      `/api/migrations/database?domainIds=${encodeURIComponent(JSON.stringify(preview.domainIds))}&fingerprint=${preview.fingerprint}`,
    );
  assert.equal(exported.status, 200);
  let bytes = new Uint8Array(await exported.arrayBuffer());
  const copy = new sql.Database(bytes);
  assert.equal(
    Number(copy.exec('SELECT count(*) FROM pdf_jobs')[0]!.values[0]![0]),
    2,
    'immutable old and current PDF versions travel together',
  );
  copy.run(
    "INSERT INTO pdf_page_fts(id,cache_id,tokens,normalized,page_number) VALUES('poison','fake','poisonfts','poisonfts',1)",
  );
  bytes = copy.export();
  copy.close();
  const restore = await runtime.previewRestore(bytes, 'pdf-migration.sqlite');
  await runtime.restore(restore.token);
  await runtime.close();
  runtime = await createLocalRuntime(sql, learningSeed(), storage, { dailyPushScheduler: false });
  assert.equal((await api('/api/search?q=poisonfts')).total, 0);
  assert.equal((await api(`/api/pdf-index/assets/${oldAsset.id}/search?q=oldprefix`)).total, 1);
  assert.equal(
    (await api(`/api/pdf-index/assets/${newAsset.id}/search?q=${encodeURIComponent('沉没成本')}`))
      .total,
    1,
  );
  const damaged = new sql.Database(durable!);
  damaged.run("UPDATE pdf_caches SET data=json_set(data,'$.extractorVersion',999)");
  const damagedBytes = damaged.export();
  damaged.close();
  await assert.rejects(() => runtime.previewRestore(damagedBytes, 'bad-pdf.sqlite'));
  assert.equal((await api('/api/search?q=opport')).counts.document, 1);
});
