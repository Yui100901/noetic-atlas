/** Actual Capacitor/WebView acceptance. Only the separately identified .qa
 * installation is touched; its disposable database is cleared by the helper. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { unzipSync } from 'fflate';
import { connectAndroid, until, QA_PACKAGE } from '../testing/android/device.mjs';
import { seedAndroidLayout } from '../testing/android/layout-fixture.mjs';

const { values } = parseArgs({
  options: {
    serial: { type: 'string' },
    'background-transfers': { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'check-android-functional.mjs --serial DEVICE [--background-transfers]\nRequires separate QA APK; synthetic native persistence, practice/exam, ZIP, PDF and SQLite restore. Local fake AI only. Never opens the production installation.',
  );
  process.exit(0);
}
const folder = resolve('test-results/android-functional');
await mkdir(folder, { recursive: true });
let device, provider, reversePort;
let providerDelayMs = 0;
const report = {
  ok: false,
  isolated: true,
  package: QA_PACKAGE,
  checks: [],
  providerRequests: [],
  timings: {},
};
const stage = async (name, action) => {
  const start = performance.now(),
    result = await action();
  report.timings[name] = Math.round(performance.now() - start);
  report.checks.push(name);
  await writeFile(join(folder, 'progress.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ stage: name, ms: report.timings[name] }));
  return result;
};
try {
  device = await connectAndroid({ serial: values.serial });
  const { api, go, adb } = device;
  const page = () => device.page;
  const completed = async (id) => {
    await until(
      async () => {
        const task = await api('/api/tasks/' + id);
        if (['failed', 'interrupted', 'cancelled'].includes(task.status))
          throw Error('Background task did not complete: ' + task.message);
        return task.status === 'completed';
      },
      'native background task completion',
      60000,
    );
    return api('/api/tasks/' + id + '/result');
  };
  const task = async (operation, method = 'POST', body) => {
    const queued = await api('/api/tasks', 'POST', { operation, method, body });
    return { id: queued.id, result: await completed(queued.id) };
  };
  const transfer = async (operation, body) =>
    values['background-transfers']
      ? (await task(operation, 'POST', body)).result.json
      : api(operation, 'POST', body);
  const nativeBytes = (url) =>
    page().evaluate(async (url) => {
      const response = await window.__noeticQA.nativeFetch(url);
      if (!response.ok) throw Error('Native binary download failed: ' + response.status);
      return Array.from(new Uint8Array(await response.arrayBuffer()));
    }, url);
  report.serial = device.serial;
  report.original = device.original;
  assert.equal((await api('/api/bootstrap')).stats.totalQuestions, 0);
  const state = await stage('native fixture writes to disposable SQLite', () =>
    seedAndroidLayout(api),
  );
  assert.equal((await api('/api/bootstrap')).stats.totalQuestions, 17);
  await stage('practice stopwatch pauses outside the page and continues one draft', async () => {
    await go('attempts/' + state.draftId);
    await until(
      async () => (await api('/api/attempts/' + state.draftId)).practiceTiming?.running,
      'visible practice starts stopwatch',
    );
    await page()
      .locator('#exam-1 textarea')
      .fill('全部操作整体提交或回滚，转账的扣款与入账应同时完成。');
    await page().locator('#exam-2 input[type=radio]').first().check();
    await delay(1500);
    await page().locator('.sidebar a[href="#/papers"]').click();
    await until(
      async () => !(await api('/api/attempts/' + state.draftId)).practiceTiming?.running,
      'navigation pauses stopwatch',
    );
    const saved = await api('/api/attempts/' + state.draftId);
    assert.ok(saved.practiceTiming.elapsedMilliseconds > 0);
    await delay(2200);
    assert.equal(
      (await api('/api/attempts/' + state.draftId)).practiceTiming.elapsedMilliseconds,
      saved.practiceTiming.elapsedMilliseconds,
    );
    await go('attempts/' + state.draftId);
    await page().locator('#exam-1 textarea').waitFor();
    assert.match(await page().locator('#exam-1 textarea').inputValue(), /扣款与入账/);
    // Exercise the real Capacitor App state hook, rather than just navigating
    // inside React. Returning through a new process must not charge the gap.
    adb('shell', 'input', 'keyevent', '3');
    await delay(2000);
    await device.restart();
    const backgrounded = await api('/api/attempts/' + state.draftId);
    await delay(1500);
    assert.equal(
      (await api('/api/attempts/' + state.draftId)).practiceTiming.elapsedMilliseconds,
      backgrounded.practiceTiming.elapsedMilliseconds,
    );
    await go('attempts/' + state.draftId);
    await page().locator('#exam-1 textarea').waitFor();
    assert.match(await page().locator('#exam-1 textarea').inputValue(), /扣款与入账/);
    await page().getByRole('button', { name: '交卷并查看解析', exact: true }).first().click();
    await until(
      async () => (await api('/api/attempts/' + state.draftId)).status === 'submitted',
      'real UI submission',
    );
    const submitted = await api('/api/attempts/' + state.draftId);
    assert.match(submitted.answers['ANDROID-LAYOUT-0'].value, /整体提交/);
    assert.equal(submitted.answers['ANDROID-LAYOUT-1'].value, 'true');
    assert.equal(submitted.practiceTiming.running, false);
  });
  await stage('one-minute native exam locks APIs then auto-submits and unlocks', async () => {
    const exam = await api('/api/papers/' + state.paperId + '/attempts', 'POST', {
      mode: 'exam',
      durationMinutes: 1,
    });
    await go('attempts/' + exam.id);
    const locked = await page().evaluate(async () => {
      const checks = [
        ['/api/questions', 'GET'],
        ['/api/tasks', 'GET'],
        ['/api/tasks/qa-exam-locked/input', 'GET'],
        ['/api/tasks/qa-exam-locked/result', 'GET'],
        ['/api/tasks/qa-exam-locked/download', 'GET'],
        ['/api/tasks', 'POST'],
      ];
      return Promise.all(
        checks.map(async ([url, method]) => [
          url,
          method,
          (
            await window.__noeticQA.nativeFetch(url, {
              method,
              ...(method === 'POST'
                ? {
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ operation: '/api/ai/explain', body: {} }),
                  }
                : {}),
            })
          ).status,
        ]),
      );
    });
    for (const [url, method, status] of locked)
      assert.equal(status, 409, method + ' ' + url + ' must not expose content during an exam');
    await until(
      async () => (await api('/api/attempts/' + exam.id)).status === 'submitted',
      'actual countdown auto submission',
      80000,
    );
    const submitted = await api('/api/attempts/' + exam.id);
    assert.equal(submitted.autoSubmitted, true);
    assert.ok((await api('/api/questions?pageSize=5')).total >= 17);
  });
  await stage('Capacitor HTTP AI transport and explicit note application', async () => {
    provider = createServer(async (request, response) => {
      try {
        const latency = providerDelayMs;
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const message = body.messages[1].content;
        const material = JSON.parse(
          typeof message === 'string' ? message : message[0].text,
        ).untrustedMaterial;
        assert.equal(request.headers.authorization, 'Bearer android-fixture-only');
        report.providerRequests.push({
          path: request.url,
          method: request.method,
          model: body.model,
        });
        if (latency) await delay(latency);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    explanationMarkdown: 'Android本机AI传输解释：' + material.question.stemMarkdown,
                    followUpsMarkdown: '核对事务边界。',
                    pitfallsMarkdown: '不要混淆原子性与隔离性。',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
          }),
        );
      } catch {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'ANDROID_QA_PROVIDER_FAILED' } }));
      }
    });
    await new Promise((done) => provider.listen(0, '127.0.0.1', done));
    reversePort = provider.address().port;
    adb('reverse', 'tcp:' + reversePort, 'tcp:' + reversePort);
    await api('/api/ai/settings', 'PUT', {
      enabled: true,
      baseUrl: 'http://127.0.0.1:' + reversePort,
      model: 'android-loopback-only',
      key: 'android-fixture-only',
      supportsImages: false,
      sendImages: false,
      timeoutSeconds: 30,
      maxTokens: 4096,
    });
    const before = (await api('/api/questions/ANDROID-LAYOUT-0')).study.notes;
    const run = await api('/api/ai/explain', 'POST', { questionId: 'ANDROID-LAYOUT-0' });
    assert.match(run.result.explanationMarkdown, /Android本机AI传输解释/);
    assert.equal((await api('/api/questions/ANDROID-LAYOUT-0')).study.notes, before);
    await api('/api/ai/runs/' + run.id + '/apply', 'POST', { confirmed: true, appendNotes: true });
    assert.match(
      (await api('/api/questions/ANDROID-LAYOUT-0')).study.notes,
      /Android本机AI传输解释/,
    );
    assert.equal(report.providerRequests.length, 1);
  });
  await stage(
    'native AI worker survives route changes, notifies completion and supports cancel/retry',
    async () => {
      const create = () =>
        api('/api/tasks', 'POST', {
          operation: '/api/ai/explain',
          body: { questionId: 'ANDROID-LAYOUT-0' },
          title: 'Android跨页后台AI',
          returnTo: '#/questions/ANDROID-LAYOUT-0',
        });
      providerDelayMs = 6000;
      const task = await create();
      assert.ok(task.id);
      await until(
        async () => (await api('/api/tasks/' + task.id)).status === 'running',
        'AI worker starts',
      );
      await page().locator('.sidebar a[href="#/documents"]').click();
      await page().waitForURL(/#\/documents/);
      await page()
        .getByRole('heading', { name: '让书籍、笔记和思路各归其位。', exact: true })
        .waitFor();
      const responsiveStart = performance.now();
      assert.equal((await api('/api/bootstrap')).stats.totalQuestions, 17);
      report.backgroundReadMs = Math.round(performance.now() - responsiveStart);
      assert.equal(
        (await api('/api/tasks/' + task.id)).status,
        'running',
        'page content and live database reads must finish before the delayed provider',
      );
      const result = await completed(task.id);
      assert.match(result.json.result.explanationMarkdown, /Android本机AI传输解释/);
      await page().getByRole('link', { name: '后台任务与通知', exact: true }).click();
      await page().getByRole('region', { name: '后台任务列表', exact: true }).waitFor();
      assert.ok(await page().getByText('Android跨页后台AI', { exact: true }).count());
      providerDelayMs = 10000;
      const cancelled = await create();
      await until(
        async () => (await api('/api/tasks/' + cancelled.id)).status === 'running',
        'cancellable worker starts',
      );
      await api('/api/tasks/' + cancelled.id + '/cancel', 'POST', {});
      await until(
        async () => (await api('/api/tasks/' + cancelled.id)).status === 'cancelled',
        'worker acknowledges cancellation',
      );
      providerDelayMs = 0;
      const retry = await api('/api/tasks/' + cancelled.id + '/retry', 'POST', {});
      assert.equal(retry.id, cancelled.id);
      assert.equal(retry.attempt, 2);
      assert.match(
        (await completed(retry.id)).json.result.explanationMarkdown,
        /Android本机AI传输解释/,
      );
      report.backgroundTask = { completed: task.id, cancelled: cancelled.id, retried: retry.id };
      await page().screenshot({ path: join(folder, 'native-background-tasks.png') });
      await device.restart();
      assert.equal((await api('/api/tasks/' + task.id)).status, 'completed');
      assert.match(
        (await api('/api/tasks/' + task.id + '/result')).json.result.explanationMarkdown,
        /Android本机AI传输解释/,
      );
      assert.equal((await api('/api/tasks/' + retry.id)).status, 'completed');
    },
  );
  await stage(
    'actual PDF.js worker creates durable FTS4 pages and immutable source links',
    async () => {
      const pdf = await PDFDocument.create(),
        font = await pdf.embedFont(StandardFonts.Helvetica);
      for (const word of ['androidpdfalpha', 'androidpdfbeta'])
        pdf.addPage().drawText('Native PDF text ' + word, { x: 30, y: 700, font, size: 14 });
      const asset = await api('/api/assets', 'POST', {
        filename: 'android-qa.pdf',
        mimeType: 'application/pdf',
        dataBase64: Buffer.from(await pdf.save()).toString('base64'),
      });
      const document = await api('/api/documents', 'POST', {
        title: 'Android PDF全文验收',
        kind: '书籍',
        format: 'pdf',
        assetId: asset.id,
        domainIds: ['android-layout'],
        categoryIds: ['android-layout-category'],
      });
      report.pdfAssetId = asset.id;
      report.pdfDocumentId = document.id;
      await go('documents/' + document.id, { reload: false });
      await until(
        async () =>
          (await api('/api/pdf-index/jobs')).some(
            (job) => job.assetId === asset.id && job.status === 'complete',
          ),
        'native PDF.js text indexing',
        90000,
      );
      const hits = await api('/api/pdf-index/assets/' + asset.id + '/search?q=androidpdfbeta');
      assert.equal(hits.total, 1);
      assert.equal(hits.hits[0].pageNumber, 2);
      const search = await api('/api/search?q=androidpdfbeta');
      assert.equal(search.counts.document, 1);
      assert.ok(
        search.items.some(
          (item) => item.type === 'document' && item.pdfHits?.some((hit) => hit.pageNumber === 2),
        ),
      );
      await page().screenshot({ path: join(folder, 'native-pdf-index.png') });
    },
  );
  await stage(
    'ZIP share keeps full metadata, imports exactly once and preserves local learning',
    async () => {
      const file = await transfer('/api/packages/export', {
        kind: 'share',
        selection: { kind: 'paper', id: state.paperId },
      });
      assert.ok(file.byteLength > 0);
      await writeFile(join(folder, 'native-share.zip'), Buffer.from(file.dataBase64, 'base64'));
      const count = (await api('/api/questions?status=all&pageSize=5')).total;
      const notes = (await api('/api/questions/ANDROID-LAYOUT-0')).study.notes;
      const preview = await transfer('/api/packages/preview', { dataBase64: file.dataBase64 });
      assert.equal(preview.dedup.counts.exact, 17);
      await transfer('/api/packages/import', {
        dataBase64: file.dataBase64,
        expectedFingerprint: preview.fingerprint,
        confirmed: true,
      });
      assert.equal((await api('/api/questions?status=all&pageSize=5')).total, count);
      assert.equal((await api('/api/questions/ANDROID-LAYOUT-0')).study.notes, notes);
    },
  );
  await stage(
    'real filesystem SQLite backup validates, preserves a safety copy and restores full data',
    async () => {
      const migration = await transfer('/api/migrations/preview', { domainIds: [] });
      const url =
        '/api/migrations/database?fingerprint=' + encodeURIComponent(migration.fingerprint);
      let bytes;
      if (values['background-transfers']) {
        const sqlite = await task(url, 'GET');
        const zip = await task(url + '&format=zip', 'GET');
        bytes = await nativeBytes('/api/tasks/' + sqlite.id + '/download');
        const zipBytes = await nativeBytes('/api/tasks/' + zip.id + '/download');
        assert.equal(sqlite.result.binaryByteLength, bytes.length);
        assert.equal(zip.result.binaryByteLength, zipBytes.length);
        assert.equal(sqlite.result.binaryBase64, undefined);
        assert.equal(zip.result.binaryBase64, undefined);
        const archive = unzipSync(Uint8Array.from(zipBytes));
        assert.equal(
          JSON.parse(new TextDecoder().decode(archive['manifest.json'])).kind,
          'sqlite-backup',
        );
        assert.ok(archive['database/migration.sqlite']?.byteLength > 0);
        report.backgroundMigration = { sqliteBytes: bytes.length, zipBytes: zipBytes.length };
      } else {
        bytes = await nativeBytes(url);
      }
      await writeFile(join(folder, 'native-migration.sqlite'), new Uint8Array(bytes));
      const originalNotes = (await api('/api/questions/ANDROID-LAYOUT-0')).study.notes;
      await api('/api/study/ANDROID-LAYOUT-0', 'PUT', {
        notes: 'restore must replace this later edit',
      });
      const invalid = await page().evaluate(async () => {
        try {
          await window.__noeticQA.nativePreviewSQLiteRestore(
            new File([new Uint8Array([1, 2, 3])], 'invalid.sqlite'),
          );
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(invalid, true);
      assert.equal(
        (await api('/api/questions/ANDROID-LAYOUT-0')).study.notes,
        'restore must replace this later edit',
      );
      const restore = await page().evaluate(async (value) => {
        const preview = await window.__noeticQA.nativePreviewSQLiteRestore(
          new File([new Uint8Array(value)], 'qa-backup.sqlite'),
        );
        const result = await window.__noeticQA.nativeConfirmSQLiteRestore(preview.token);
        return { preview, result, latest: await window.__noeticQA.nativeLatestRecoveryBackup() };
      }, bytes);
      assert.equal(restore.preview.counts.questions, 18);
      assert.ok(restore.result.recoveryBackup.byteLength > 0);
      assert.equal(restore.latest.id, restore.result.recoveryBackup.id);
      assert.equal((await api('/api/questions/ANDROID-LAYOUT-0')).study.notes, originalNotes);
      assert.equal((await api('/api/attempts/' + state.draftId)).status, 'submitted');
      assert.equal(
        (await api('/api/pdf-index/assets/' + report.pdfAssetId + '/search?q=androidpdfbeta'))
          .total,
        1,
      );
      await device.restart();
      assert.equal((await api('/api/questions/ANDROID-LAYOUT-0')).study.notes, originalNotes);
      assert.equal(
        (await api('/api/pdf-index/assets/' + report.pdfAssetId + '/search?q=androidpdfbeta'))
          .total,
        1,
      );
      assert.equal((await api('/api/ai/settings')).hasKey, false);
      report.restore = {
        bytes: bytes.length,
        sourceCounts: restore.preview.counts,
        safetyBackupBytes: restore.result.recoveryBackup.byteLength,
      };
    },
  );
  assert.deepEqual(device.errors, []);
  assert.deepEqual(device.network, []);
  report.ok = true;
} catch (error) {
  report.error = String(error.stack || error);
  if (device) report.webViewErrors = device.errors;
  await device?.page
    .screenshot({ path: join(folder, 'failure.png'), fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (device && reversePort) device.adb('reverse', '--remove', 'tcp:' + reversePort);
  provider?.closeAllConnections();
  if (provider) await new Promise((done) => provider.close(done));
  try {
    await device?.close();
    report.deviceRestored = true;
  } catch (error) {
    report.cleanupError = String(error);
    report.ok = false;
    process.exitCode = 1;
  }
  if (device) {
    const cleanup = await readFile(join(device.folder, 'device-cleanup.json'), 'utf8');
    await writeFile(join(folder, 'device-cleanup.json'), cleanup);
  }
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      ok: report.ok,
      checks: report.checks.length,
      deviceRestored: report.deviceRestored,
      report: join(folder, 'report.json'),
    }),
  );
}
