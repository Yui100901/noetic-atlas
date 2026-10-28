/** Persistent document drafts are exercised against an isolated in-memory app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument } from 'pdf-lib';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/document-drafts-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-document-drafts-ui-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('DOCUMENT_DRAFTS_READY '+JSON.stringify({origin}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page, rejectNextConfirm = false;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-12000));
const checks = [], errors = [], externalRequests = [], dialogs = [];
try {
  let connection;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('DOCUMENT_DRAFTS_READY '));
    if (line) { connection = JSON.parse(line.slice('DOCUMENT_DRAFTS_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(connection, stderr); const { origin } = connection;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const attach = async target => {
    target.setDefaultTimeout(15000); target.on('pageerror', error => errors.push(error.message));
    target.on('dialog', dialog => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'confirm' && rejectNextConfirm) { rejectNextConfirm = false; void dialog.dismiss(); } else void dialog.accept();
    });
    await target.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  };
  page = await context.newPage(); await attach(page);
  const api = async (path, method = 'GET', data, expected = 200) => {
    const response = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    const text = await response.text(); assert.equal(response.status(), expected, path + ': ' + text); return text ? JSON.parse(text) : null;
  };
  const drafts = documentId => api('/api/document-drafts' + (documentId ? '?documentId=' + encodeURIComponent(documentId) : ''));
  const waitFor = async (run, message) => {
    let latest;
    for (let index = 0; index < 100; index++) { latest = await run(); if (latest) return latest; await delay(100); }
    assert.fail(message || 'Condition did not become true: ' + String(latest));
  };
  let navigation = 0;
  const go = async (path, target = page) => { await target.goto(origin + '/?draft-ui=' + ++navigation + '#/' + path); await target.waitForLoadState('networkidle'); };
  const body = (target = page) => target.getByLabel('资料正文', { exact: true });
  const title = (target = page) => target.getByLabel('资料标题 *', { exact: true });
  const ready = async (target = page) => { await body(target).waitFor(); await waitFor(() => body(target).isEnabled(), 'Editor remains disabled'); };
  const recover = async (target = page) => { const picker = target.getByRole('dialog', { name: '继续资料草稿', exact: true }); await picker.waitFor(); await picker.getByRole('button', { name: '继续此草稿', exact: true }).first().click(); };
  const capture = async name => { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow'); await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true }); };
  const publish = async (buttonName = '保存资料') => {
    const response = page.waitForResponse(result => new URL(result.url()).pathname.endsWith('/publish') && result.request().method() === 'POST');
    await page.getByRole('button', { name: buttonName, exact: true }).click(); const result = await response;
    assert.ok(result.status() === 200 || result.status() === 201, await result.text()); const record = await result.json();
    await page.waitForURL(new RegExp('#/documents/' + record.id + '$')); return record;
  };

  await go('documents/new'); await ready(); await delay(1100); assert.equal((await drafts()).length, 0, 'An untouched blank editor should not create a draft');
  await body().fill('# 未命名的草稿\n\n只写正文也应该留存。');
  const first = await waitFor(async () => { const items = await drafts(); return items.length === 1 && items[0].state.bodyMarkdown.includes('只写正文') ? items[0] : null; }, 'Blank-title body was not auto-saved');
  assert.equal(first.state.title, ''); assert.equal((await api('/api/documents')).length, 0);
  await body().fill('# 未命名的草稿\n\n继续补充内容。'); await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await waitFor(async () => { const items = await drafts(); return items.length === 1 && items[0].id === first.id && items[0].state.bodyMarkdown.includes('继续补充') ? items[0] : null; });
  await page.getByRole('status', { name: '资料草稿状态', exact: true }).getByText(/资料草稿已保存/).waitFor();
  checks.push('空标题正文自动保存为独立草稿，继续及手动保存更新同一ID，不进入正式资料库');
  await capture('new-draft-desktop');

  const unsaved = '# 未命名的草稿\n\n离开前最后一次输入。';
  const initialConfirmations = dialogs.filter(dialog => dialog.type === 'confirm').length;
  await body().fill(unsaved); rejectNextConfirm = true; await page.getByRole('link', { name: '返回资料库', exact: true }).click();
  assert.ok(page.url().endsWith('#/documents/new')); assert.equal(await body().inputValue(), unsaved);
  await page.getByRole('link', { name: '返回资料库', exact: true }).click(); await page.waitForURL(/#\/documents$/);
  assert.equal(dialogs.filter(dialog => dialog.type === 'confirm').length - initialConfirmations, 2, 'each leave attempt should ask exactly once');
  assert.ok(dialogs.some(dialog => dialog.type === 'confirm'), 'leaving uncommitted work should ask for confirmation');
  const persisted = await drafts(); assert.equal(persisted.length, 1); assert.equal(persisted[0].state.bodyMarkdown, unsaved);
  await page.getByRole('link', { name: '新建 / 上传资料', exact: true }).click(); await recover(); await ready(); assert.equal(await body().inputValue(), unsaved);
  await page.reload(); await recover(); await ready(); assert.equal(await body().inputValue(), unsaved);
  checks.push('内部离开先确认并保存最后输入，重新进入及刷新可选择恢复原草稿');

  await title().fill('草稿正式发布');
  const original = await publish(); assert.equal(original.bodyMarkdown, unsaved); assert.equal((await drafts()).length, 0);
  assert.equal((await api('/api/documents')).length, 1); await page.getByRole('link', { name: '编辑资料', exact: true }).click(); await ready();
  const changedBody = original.bodyMarkdown + '\n\n编辑草稿中的修改。'; await body().fill(changedBody);
  const editDraft = await waitFor(async () => { const items = await drafts(original.id); return items.length === 1 && items[0].state.bodyMarkdown === changedBody ? items[0] : null; });
  assert.equal((await api('/api/documents/' + original.id)).bodyMarkdown, original.bodyMarkdown); assert.equal(editDraft.documentId, original.id);
  await page.getByRole('link', { name: '返回资料详情', exact: true }).click(); await page.waitForURL(new RegExp('#/documents/' + original.id + '$'));
  await page.getByRole('link', { name: '编辑资料', exact: true }).click(); await recover(); await ready(); assert.equal(await body().inputValue(), changedBody);
  const updated = await publish(); assert.equal(updated.id, original.id); assert.equal(updated.bodyMarkdown, changedBody); assert.equal((await drafts(original.id)).length, 0);
  checks.push('正式保存原子发布并清理所选草稿，编辑草稿不覆盖原文，恢复后可更新原资料');

  await page.getByRole('link', { name: '编辑资料', exact: true }).click(); await ready();
  await body().fill('我的未提交分支');
  const conflictingDraft = await waitFor(async () => { const items = await drafts(original.id); return items[0]?.state.bodyMarkdown === '我的未提交分支' ? items[0] : null; });
  const remote = await api('/api/documents/' + original.id, 'PUT', { ...await api('/api/documents/' + original.id), bodyMarkdown: '另一页面已经保存的新版本' });
  const conflict = page.waitForResponse(result => new URL(result.url()).pathname.endsWith('/publish') && result.request().method() === 'POST');
  await page.getByRole('button', { name: '保存资料', exact: true }).click(); assert.equal((await conflict).status(), 409);
  assert.equal((await drafts(original.id))[0].id, conflictingDraft.id); assert.equal((await api('/api/documents/' + original.id)).bodyMarkdown, remote.bodyMarkdown);
  await page.getByRole('button', { name: '另存为新资料', exact: true }).waitFor(); const copy = await publish('另存为新资料');
  assert.notEqual(copy.id, original.id); assert.equal(copy.bodyMarkdown, '我的未提交分支'); assert.equal((await drafts(original.id)).length, 0);
  assert.equal((await api('/api/documents/' + original.id)).bodyMarkdown, remote.bodyMarkdown);
  checks.push('来源资料发生版本变化时拒绝覆盖且保留草稿，可另存新资料，原新版正文不变');

  await go('documents/' + original.id + '/edit'); await ready(); await body().fill('两个页面共同恢复的草稿');
  const shared = await waitFor(async () => { const items = await drafts(original.id); return items[0]?.state.bodyMarkdown === '两个页面共同恢复的草稿' ? items[0] : null; });
  const other = await context.newPage(); await attach(other); await go('documents/' + original.id + '/edit', other); await recover(other); await ready(other);
  await page.bringToFront();
  await body().fill('第一个页面的新版本'); await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await waitFor(async () => { const items = await drafts(original.id); return items[0]?.state.bodyMarkdown === '第一个页面的新版本' ? items[0] : null; });
  await other.bringToFront(); await body(other).fill('第二个页面的冲突内容');
  const rejected = other.waitForResponse(result => new URL(result.url()).pathname === '/api/document-drafts/' + shared.id && result.request().method() === 'PUT');
  await other.getByRole('button', { name: '保存草稿', exact: true }).click(); assert.equal((await rejected).status(), 409);
  assert.equal((await drafts(original.id))[0].state.bodyMarkdown, '第一个页面的新版本'); assert.equal(await body(other).inputValue(), '第二个页面的冲突内容');
  await other.getByRole('button', { name: '另存为新草稿', exact: true }).click();
  await waitFor(async () => { const items = await drafts(original.id); return items.length === 2 && items.some(item => item.state.bodyMarkdown === '第一个页面的新版本') && items.some(item => item.state.bodyMarkdown === '第二个页面的冲突内容') ? items : null; });
  await other.close({ runBeforeUnload: false });
  await page.bringToFront();
  checks.push('两页面恢复同一草稿时按版本拒绝旧覆盖，冲突输入可另存新草稿且两份均保留');
  await publish();

  await go('documents/new'); await ready();
  const markdown = '# 导入后未发布\n\nUTF-8正文。';
  await page.getByLabel('上传资料文件', { exact: true }).setInputFiles({ name: '草稿导入.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
  const imported = await waitFor(async () => { const items = await drafts(); return items[0]?.state.bodyMarkdown === markdown ? items[0] : null; }); assert.equal(imported.state.title, '草稿导入');
  await page.setViewportSize({ width: 390, height: 844 }); await capture('draft-mobile');
  await go('documents'); await go('documents/new'); await recover(); await ready(); assert.equal(await body().inputValue(), markdown);
  assert.ok((await body().boundingBox()).width >= 200); await capture('restored-mobile'); await publish();
  checks.push('UTF-8上传的正文与元信息纳入草稿，390px状态、选择恢复及编辑区域可用且无溢出');

  await go('documents/new'); await ready();
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  await page.getByLabel('上传资料文件', { exact: true }).setInputFiles({ name: '草稿附件.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.getByRole('button', { name: '改为Markdown', exact: true }).waitFor();
  const pdfDraft = await waitFor(async () => { const items = await drafts(); return items[0]?.state.format === 'pdf' && items[0].state.assetId ? items[0] : null; });
  await api('/api/assets/' + pdfDraft.state.assetId, 'DELETE', undefined, 409);
  await go('documents'); await go('documents/new'); await recover(); await page.getByRole('button', { name: '改为Markdown', exact: true }).waitFor();
  const pdfDocument = await publish(); assert.equal(pdfDocument.format, 'pdf'); assert.equal(pdfDocument.assetId, pdfDraft.state.assetId); assert.equal((await drafts()).length, 0);
  checks.push('PDF附件随草稿恢复且受引用保护，发布后附件仍存在并清理草稿');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, errors, externalRequests, isolated: true, databasePath: ':memory:', leaveConfirmations: dialogs.filter(dialog => dialog.type === 'confirm').length };
  await rm(resolve(output, 'failure.png'), { force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ url: page?.url(), checks, stderr }); throw error;
} finally { await browser?.close(); server.kill(); }
