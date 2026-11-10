/** Explicit operator-selected books, read-only originals, disposable app DB.
 * Run with --books-root DIR [--live-ai]; reports never contain source bodies. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const { values } = parseArgs({
  options: { 'books-root': { type: 'string' }, 'live-ai': { type: 'boolean' } },
});
assert.ok(
  values['books-root'],
  '--books-root is required; no operator directory is opened implicitly',
);
const booksRoot = resolve(values['books-root']);
const names = [
  {
    file: '曼昆经济学原理中文版.pdf',
    query: '微观经济学',
    expectedPage: 25,
    language: 'zh',
    aiPage: 25,
  },
  {
    file: 'Logic and Computer Design Fundamentals 5th Edition.pdf',
    query: 'binary',
    expectedPage: 35,
    language: 'en',
    aiPage: 35,
  },
  { file: '机器学习.pdf', scanned: true },
  {
    file: '深度学习中文版.pdf',
    query: 'softmax',
    expectedPage: 100,
    language: 'zh',
    formula: true,
  },
];
async function inventory(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) found.push(...(await inventory(join(dir, item.name))));
    else if (item.name.toLowerCase().endsWith('.pdf')) found.push(join(dir, item.name));
  }
  return found;
}
const files = await inventory(booksRoot);
assert.ok(files.length >= 4, 'Expected a real-book directory');
const sourceFiles = names.map((item) => {
  const path = files.find(
    (path) => path.endsWith('/' + item.file) || path.endsWith('\\' + item.file),
  );
  assert.ok(path, 'Missing selected book: ' + item.file);
  return { ...item, path };
});
const hashes = new Map();
for (const book of sourceFiles)
  hashes.set(
    book.path,
    createHash('sha256')
      .update(await readFile(book.path))
      .digest('hex'),
  );
let config, configHash;
async function readConfiguration() {
  const { DatabaseConnection } = await import('../../server/database/connection.ts');
  const db = new DatabaseConnection(resolve('data/noetic-atlas.sqlite'), false);
  try {
    return db.getRecord('ai_settings', 'local');
  } finally {
    db.close();
  }
}
if (values['live-ai']) {
  config = await readConfiguration();
  assert.ok(
    config?.enabled && config.key && config.model,
    'Configured AI is required for --live-ai',
  );
  configHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
const h = await startBrowserHarness({
  name: 'real-pdf-books',
  backgroundTasks: true,
  setup: String.raw`
const api=async(url,method='GET',payload)=>{const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<300,r.body);return r.json();};
const settings=await api('/api/settings');await api('/api/settings','PUT',{settings:{...settings,maxDocumentMiB:50}});
return{};`,
});
// The fixture contains no test-only access to the installation DB. Range text
// is extracted by the actual library-source browser flow, not copied by Node.
const { page, origin, folder } = h,
  checks = [],
  books = [],
  ai = [];
const pdfUploadTimeout = 120_000;
const api = async (url, method = 'GET', data, expected = 200) => {
  const response = await page.request.fetch(origin + url, {
    method,
    timeout: 300000,
    ...(data === undefined ? {} : { data }),
  });
  assert.equal(response.status(), expected, (await response.text()).slice(0, 1800));
  return response.json();
};
const wait = async (predicate, label, timeout = 300000) => {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error('Timed out: ' + label);
};
const jobFor = async (assetId) =>
  (await api('/api/pdf-index/jobs')).find((item) => item.assetId === assetId);
const openQuestionBank = async () => {
  await page.getByRole('link', { name: /^知识题库/ }).click();
  await page.waitForURL(/#\/questions$/);
  await page.getByRole('heading', { level: 1 }).waitFor();
};
async function background(operation, body, checkpointed = false) {
  const started = await api(
    '/api/tasks',
    'POST',
    {
      operation,
      ...(checkpointed ? { steps: [body] } : { body }),
    },
    202,
  );
  const task = await wait(
    async () => {
      const status = await api('/api/tasks/' + started.id);
      if (['failed', 'cancelled', 'interrupted'].includes(status.status))
        throw Error(`${operation}: ${status.error?.code || status.status} ${status.message}`);
      return status.status === 'completed' ? status : null;
    },
    'background textbook task',
    300000,
  );
  assert.equal(task.completedSteps, 1);
  return (await api(`/api/tasks/${task.id}/result`)).json;
}
try {
  if (config) {
    const { updatedAt: _updatedAt, ...portable } = config;
    await api('/api/ai/settings', 'PUT', portable);
  }
  for (const [index, book] of sourceFiles.entries()) {
    const title = `真实教材验收 ${index + 1} · ${book.file}`;
    await page.goto(origin + '/?real-pdf=' + index + '#/documents/new');
    await page.getByLabel('资料标题 *', { exact: true }).fill(title);
    const start = performance.now();
    const [upload] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/assets' && r.request().method() === 'POST',
        { timeout: pdfUploadTimeout },
      ),
      page
        .getByLabel('上传资料文件', { exact: true })
        .setInputFiles(book.path, { timeout: pdfUploadTimeout }),
    ]);
    assert.equal(upload.status(), 201, 'Actual upload HTTP status');
    await wait(
      () => page.getByRole('button', { name: '保存资料', exact: true }).isEnabled(),
      'PDF upload ready',
    );
    await page.getByRole('button', { name: '保存资料', exact: true }).click();
    await page.waitForURL(/#\/documents\/(?!new)[^/?]+/, { timeout: pdfUploadTimeout });
    const id = decodeURIComponent(new URL(page.url()).hash.match(/^#\/documents\/([^/?]+)/)[1]);
    const document = await api('/api/documents/' + encodeURIComponent(id));
    assert.ok(document.assetId);
    const asset = await api('/api/assets/' + document.assetId);
    assert.equal(asset.filename, book.file);
    const uploadedMs = Math.round(performance.now() - start);
    let pause = null;
    if (index === 0) {
      await wait(async () => {
        const job = await jobFor(asset.id);
        if (job?.status === 'failed') throw Error('Real PDF index failed: ' + job.error);
        return job?.cache?.processedPages >= 8;
      }, 'first checkpoint');
      await page
        .getByRole('region', { name: 'PDF全文索引', exact: true })
        .getByRole('button', { name: '暂停', exact: true })
        .click();
      await openQuestionBank();
      await new Promise((done) => setTimeout(done, 350));
      const stopped = await jobFor(asset.id),
        count = stopped.cache.processedPages;
      assert.equal(stopped.status, 'paused');
      await new Promise((done) => setTimeout(done, 350));
      assert.equal((await jobFor(asset.id)).cache.processedPages, count);
      await api('/api/pdf-index/jobs/' + encodeURIComponent(stopped.id) + '/control', 'POST', {
        action: 'resume',
      });
      await page.evaluate(() => window.dispatchEvent(new Event('atlas-pdf-jobs')));
      pause = { processedPages: count, pausedOutsideReader: true };
      checks.push('真实中文长书暂停后不增长，切到题库可正常使用，恢复后从断点继续');
    } else {
      await openQuestionBank();
    }
    const job = await wait(async () => {
      const job = await jobFor(asset.id);
      if (job?.status === 'failed') throw Error('Index failed: ' + job.error);
      return job?.status === 'complete' ? job : false;
    }, 'full-book indexing ' + book.file);
    const indexedMs = Math.round(performance.now() - start) - uploadedMs;
    assert.equal(job.cache.processedPages, job.cache.pageCount);
    if (book.scanned) assert.equal(job.cache.status, 'needs_ocr');
    else {
      assert.equal(job.cache.status, 'ready');
      const result = await api(
        `/api/pdf-index/assets/${asset.id}/search?q=${encodeURIComponent(book.query)}&pageSize=100`,
      );
      assert.ok(result.total > 0, 'Real source term not found: ' + book.query);
      const hit = result.hits.find((hit) => hit.pageNumber === book.expectedPage);
      assert.ok(hit, 'Independently checked file page missing from indexed hits');
      await page.goto(
        origin +
          `/#/documents/${encodeURIComponent(id)}/source?` +
          new URLSearchParams({
            version: document.contentVersion,
            page: String(hit.pageNumber),
            q: book.query,
          }),
      );
      await page.locator(`canvas[aria-label="PDF文件第${hit.pageNumber}页"]`).waitFor();
      await wait(
        async () => (await page.locator('.pdf-text-highlight').count()) > 0,
        'real PDF coordinate highlight',
      );
      await page.screenshot({
        path: join(folder, `book-${index + 1}-highlight.png`),
        fullPage: true,
      });
      book.hit = {
        query: book.query,
        totalPages: result.total,
        firstVerifiedFilePage: hit.pageNumber,
      };
    }
    const entry = {
      filename: book.file,
      relativePath: relative(booksRoot, book.path),
      bytes: (await stat(book.path)).size,
      pages: job.cache.pageCount,
      textPages: job.cache.textPages,
      status: job.cache.status,
      uploadedMs,
      indexedMs,
      pause,
      hit: book.hit,
      assetId: asset.id,
      documentId: id,
      contentVersion: document.contentVersion,
    };
    books.push(entry);
    console.log(
      JSON.stringify({
        stage: 'book-indexed',
        filename: book.file,
        pages: entry.pages,
        textPages: entry.textPages,
        status: entry.status,
        uploadedMs,
        indexedMs,
      }),
    );
  }
  checks.push('四份真实书籍通过实际上传保存；中英长书与公式书全文索引，扫描件明确需OCR');
  const oversized = files.find((path) => path.endsWith('C Primer Plus.pdf'));
  assert.ok(oversized && (await stat(oversized)).size > 128 * 1024 * 1024);
  const assetsBeforeLimit = (await api('/api/assets?page=1&pageSize=10')).total;
  await page.goto(origin + '/?large-pdf=1#/documents/new');
  await page.getByLabel('上传资料文件', { exact: true }).setInputFiles(oversized);
  await page.getByRole('alert').filter({ hasText: '资料超过50 MiB' }).waitFor();
  assert.equal((await api('/api/assets?page=1&pageSize=10')).total, assetsBeforeLimit);
  await page.goto(origin + '/?large-pdf=2#/sharing?tab=import');
  await page.getByLabel('AI导入原始文件', { exact: true }).setInputFiles(oversized);
  await page.getByRole('alert').filter({ hasText: /128/ }).waitFor();
  assert.equal((await api('/api/ai/runs?page=1&pageSize=10')).total, 0);
  checks.push('216MiB真实大书在资料库50MiB与AI单文件128MiB限额前明确拒绝，不创建附件或模型请求');
  if (config) {
    for (const [index, book] of sourceFiles.slice(0, 2).entries()) {
      await page.goto(origin + '/?book-ai=' + index + '#/sharing?tab=import&process=batch');
      const picker = page.getByRole('dialog', { name: '继续AI辅助草稿', exact: true });
      if (index > 0) {
        await picker.waitFor();
        await picker.getByRole('button', { name: '新建草稿', exact: true }).click();
      }
      await page.getByLabel('PDF起始页（可选）', { exact: true }).fill(String(book.aiPage));
      await page.getByLabel('PDF结束页（可选）', { exact: true }).fill(String(book.aiPage));
      await page.getByRole('button', { name: '从资料库选择教材并关联原文', exact: true }).click();
      await page
        .getByRole('region', { name: '选择原文资料', exact: true })
        .getByRole('button')
        .filter({ hasText: books[index].filename })
        .click();
      await page
        .getByText('已关联资料库固定版本，出题后可返回原文核对。', { exact: true })
        .waitFor();
      await page.getByLabel('每块最多题量', { exact: true }).fill('5');
      await page.getByLabel('整个任务最多题量', { exact: true }).fill('5');
      await page
        .getByLabel('分批出题要求', { exact: true })
        .fill(
          '只依据本次文件页生成5道基础巩固题。用中文提问和解析，包含判断、单选、简答；各题考查不同知识点。不得捏造来源、页码或缺失图片。参考答案要能从原文核对，不要大段抄录原文。',
        );
      await page.getByRole('button', { name: '创建可恢复教材任务', exact: true }).click();
      const job = await wait(async () => {
        const list = await api('/api/ai/document-jobs?page=1&pageSize=20');
        return list.items.find(
          (item) =>
            item.sourceName === books[index].filename ||
            item.sourceName.includes(books[index].filename),
        );
      }, 'real textbook task');
      let detail = await api('/api/ai/document-jobs/' + job.id);
      assert.equal(detail.blockCount, 1, 'One selected page should form one bounded block');
      assert.equal(detail.blocks[0].sourceCitation.documentId, books[index].documentId);
      assert.equal(detail.blocks[0].sourceCitation.pageStart, book.aiPage);
      const start = performance.now(),
        payload = { blockIds: detail.blocks.map((block) => block.id) };
      await background(`/api/ai/document-jobs/${job.id}/plan`, payload, true);
      detail = await background(`/api/ai/document-jobs/${job.id}/generate`, payload, true);
      assert.equal(detail.failedBlocks, 0, 'AI generation failed; inspect safe run diagnostics');
      assert.ok(
        detail.questionCount >= 3 && detail.questionCount <= 5,
        'Unexpected generated quantity',
      );
      const questions = detail.blocks.flatMap((block) => block.questions);
      for (const q of questions) {
        assert.equal(q.status, 'pending');
        assert.ok(q.stemMarkdown.trim() && q.answerMarkdown.trim());
        assert.equal(q.documentLinks[0].documentId, books[index].documentId);
        assert.equal(q.documentLinks[0].pageStart, book.aiPage);
      }
      assert.equal(
        (await api('/api/questions?status=all&pageSize=10')).total,
        ai.reduce((n, item) => n + item.imported, 0),
      );
      const importPreview = await background(`/api/ai/document-jobs/${job.id}/import-preview`, {
        ...payload,
        confirmed: true,
      });
      const decisions = importPreview.items
        .filter((item) => item.kind === 'similar')
        .map((item) => ({ key: item.key, action: 'both' }));
      const imported = await background(`/api/ai/document-jobs/${job.id}/import`, {
        ...payload,
        confirmed: true,
        dedup: { expectedFingerprint: importPreview.fingerprint, decisions },
      });
      const runs = (await api('/api/ai/runs?page=1&pageSize=100')).items.filter(
        (run) => run.jobId === job.id,
      );
      const providerCalls = runs.reduce((n, run) => n + (run.diagnostics?.providerCalls || 0), 0);
      assert.ok(providerCalls <= 3, 'Live request budget exceeded');
      ai.push({
        filename: book.file,
        filePage: book.aiPage,
        generated: detail.questionCount,
        imported: imported.added,
        background: true,
        durationMs: Math.round(performance.now() - start),
        types: [...new Set(questions.map((q) => q.type))],
        providerCalls,
        usage: runs.map((run) => run.diagnostics?.usage),
        questions: questions.map((q) => ({
          title: q.title,
          type: q.type,
          stem: q.stemMarkdown,
          answer: q.answerMarkdown,
          explanation: q.explanationMarkdown,
        })),
      });
      await writeFile(join(folder, 'generated-review.json'), JSON.stringify(ai, null, 2));
      await writeFile(
        join(folder, 'progress.json'),
        JSON.stringify(
          { books, checks, ai: ai.map(({ questions: _questions, ...item }) => item) },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          stage: 'real-book-ai-complete',
          filename: book.file,
          filePage: book.aiPage,
          generated: detail.questionCount,
          providerCalls,
        }),
      );
    }
    checks.push(
      '真实中英教材经资料库页范围抽取、AI总结和出题，固定原文引用，确认前不新增，确认后待审核',
    );
  }
  for (const book of sourceFiles)
    assert.equal(
      createHash('sha256')
        .update(await readFile(book.path))
        .digest('hex'),
      hashes.get(book.path),
      'Original book changed',
    );
  if (config)
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify(await readConfiguration()))
        .digest('hex'),
      configHash,
      'Working AI configuration changed',
    );
  h.assertClean();
  await writeFile(join(folder, 'generated-review.json'), JSON.stringify(ai, null, 2));
  const report = {
    ok: true,
    booksRootSuppliedExplicitly: true,
    originalPdfCount: files.length,
    originalsUnchanged: true,
    workingDataChanged: false,
    browserErrors: h.errors,
    externalBrowserRequests: h.external,
    checks,
    books,
    ai: ai.map(({ questions: _questions, ...item }) => item),
  };
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await h.captureFailure(error, { books, checks });
  throw error;
} finally {
  await h.close();
}
