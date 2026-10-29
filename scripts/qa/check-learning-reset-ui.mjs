/** Reset confirmation UI against mocked API responses; never opens a database. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'test-results/learning-reset-ui');
const { DEFAULT_SETTINGS } = await tsImport('../../shared/models/settings.ts', import.meta.url);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const staticRoot = resolve(root, 'dist/web');
const origin = 'http://noetic-reset.invalid';
let browser, page;
const checks = [], errors = [], unexpected = [], submissions = [], pendingModules = new Set();
let previews = 0, settingsWrites = 0;
const preview = { counts: { states: 6, partStates: 4, reviews: 9, results: 12 }, retained: { attempts: 15, drafts: 2 } };
await mkdir(output, { recursive: true });
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => pendingModules.add(request.url()));
  page.on('requestfinished', request => pendingModules.delete(request.url()));
  page.on('requestfailed', request => pendingModules.delete(request.url()));
  // This suite verifies deployed UI against mocked APIs, not Vite/StrictMode.
  // Serve the exact built files through interception; no server or DB is opened.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { unexpected.push('EXTERNAL ' + url.origin); return route.abort(); }
    const file = resolve(staticRoot, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(staticRoot + sep)) return route.fulfill({ status: 404 });
    try {
      const body = await readFile(file);
      const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' })[extname(file)] || 'application/octet-stream';
      return route.fulfill({ status: 200, contentType, body });
    } catch { unexpected.push('STATIC ' + url.pathname); return route.fulfill({ status: 404 }); }
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const fulfill = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/bootstrap') return fulfill({ domains: [], categories: [], tags: [], settings: DEFAULT_SETTINGS, stats: { totalQuestions: 0 }, ai: { available: false, message: '' } });
    if (path === '/api/exams/sync') return fulfill({ attempt: null });
    if (path === '/api/daily-push') return fulfill({ config: DEFAULT_SETTINGS.dailyPush, today: null, recent: [], recentLimit: 30, unreadCount: 0, nextDateKey: '2026-10-27' });
    if (path === '/api/settings') {
      if (request.method() !== 'GET') settingsWrites++;
      return fulfill(DEFAULT_SETTINGS);
    }
    if (path === '/api/learning/reset-preview') { previews++; return fulfill({ ...preview, fingerprint: 'preview-' + previews }); }
    if (path === '/api/learning/reset') {
      submissions.push(request.postDataJSON());
      if (submissions.length === 1) return fulfill({ error: { code: 'LEARNING_RESET_PREVIEW_STALE', message: '预览已过期' } }, 409);
      if (submissions.length === 2) return fulfill({ error: { code: 'LOCAL_STORAGE_FAILED', message: '保存到手机失败，本次修改已撤销。' } }, 507);
      await delay(150); return fulfill({ ok: true, ...preview, fingerprint: submissions.at(-1).fingerprint });
    }
    unexpected.push(request.method() + ' ' + path); return fulfill({ error: { message: 'Unexpected QA API request' } }, 500);
  });
  await page.goto(origin + '/#/settings', { waitUntil: 'domcontentloaded', timeout: 45000 });
  const panel = page.getByRole('region', { name: '重置学习进度', exact: true });
  await panel.waitFor();
  assert.equal(previews, 0); assert.equal(submissions.length, 0);
  assert.equal(await page.locator('form').getByRole('region', { name: '重置学习进度', exact: true }).count(), 0);
  await page.getByLabel('随机无分练习默认题量', { exact: true }).fill('43');
  checks.push('入口独立于系统配置表单，打开页面不会预览或重置');

  const open = () => panel.getByRole('button', { name: /预览重置范围/ }).click();
  const dialog = page.getByRole('dialog', { name: '确认重置学习进度', exact: true });
  const confirm = dialog.getByRole('button', { name: '确认重置学习进度', exact: true });
  const checkbox = dialog.getByRole('checkbox');
  await open(); await dialog.waitFor();
  assert.equal(await confirm.isDisabled(), true);
  for (const text of ['6 份原题学习状态', '4 份组合小题状态', '12 份答题学习结果', '9 条复习事件', '15 份历史答题及成绩', '2 份作答草稿']) assert.ok((await dialog.innerText()).includes(text));
  await checkbox.check(); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(submissions.length, 0);
  checks.push('预览列明清除与保留数量，勾选前不能提交，取消不写入');

  await open(); await dialog.waitFor(); assert.equal(await checkbox.isChecked(), false);
  await checkbox.check(); await confirm.click();
  await panel.getByRole('button', { name: '重新预览重置范围', exact: true }).waitFor();
  await panel.getByRole('alert').filter({ hasText: '预览已过期' }).waitFor();
  assert.equal(await dialog.count(), 0); assert.equal(submissions.length, 1); assert.equal(previews, 2);
  await delay(200); assert.equal(submissions.length, 1);
  checks.push('409使旧预览失效，明确要求重新预览，不自动重试提交');

  await open(); await dialog.waitFor(); await checkbox.check(); await confirm.click();
  await dialog.getByRole('alert').filter({ hasText: '本次修改已撤销' }).waitFor();
  assert.equal(await checkbox.isChecked(), false); assert.equal(await confirm.isDisabled(), true);
  await delay(200); assert.equal(submissions.length, 2);
  checks.push('保存失败保留影响说明、撤销勾选并显示错误，不自动重试');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: resolve(output, 'confirmation-mobile.png') });
  await checkbox.check(); await confirm.click();
  await panel.getByRole('status').filter({ hasText: '学习进度已重置' }).waitFor();
  assert.equal(submissions.length, 3); assert.equal(previews, 3); assert.equal(settingsWrites, 0);
  assert.deepEqual(submissions, [{ confirmed: true, fingerprint: 'preview-2' }, { confirmed: true, fingerprint: 'preview-3' }, { confirmed: true, fingerprint: 'preview-3' }]);
  assert.equal(await page.getByLabel('随机无分练习默认题量', { exact: true }).inputValue(), '43');
  checks.push('390px确认窗无横向溢出，成功提示保留内容且不提交未保存的系统配置');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  const report = { passed: checks.length, checks, errors, unexpected, previewRequests: previews, resetRequests: submissions.length, settingsWrites, databaseAccessed: false, mode: 'built-web-mocked-api' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {}); await writeFile(resolve(output, 'failure.json'), JSON.stringify({ message: error.message, pendingModules: [...pendingModules], errors, unexpected, checks }, null, 2)); throw error; }
finally { await browser?.close(); }
