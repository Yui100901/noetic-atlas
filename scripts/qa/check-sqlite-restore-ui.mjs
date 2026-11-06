import { buildDataPackage } from '../../shared/packages/data-package.ts';
import { sqliteRecordLabels } from '../../web/features/settings/sqlite-record-labels.ts';
/** Isolated Android restore UI regression check. No installed app/data is used.
 * Run: node scripts/qa/check-sqlite-restore-ui.mjs
 * Optional PLAYWRIGHT_MODULE: module specifier or absolute Playwright index.mjs.
 * Optional PLAYWRIGHT_CHROMIUM_EXECUTABLE: installed Chromium executable.
 * Screenshots and generated mock fixtures stay under test-results/.
 */
import { build } from 'vite';
import { createServer } from 'node:http';
import react from '@vitejs/plugin-react';
import { writeFile, readFile, readdir, mkdir, access } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const folder = resolve(root, 'test-results/native-restore-ui');
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    const module = process.env.PLAYWRIGHT_MODULE;
    return import(isAbsolute(module) ? pathToFileURL(module).href : module);
  }
  try {
    return await import('playwright');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  // Codex's bundled dependency runtime is optional; plain project installations
  // can provide Playwright normally or point PLAYWRIGHT_MODULE at their runtime.
  const bundled = join(
    homedir(),
    '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs',
  );
  if (await exists(bundled)) return import(pathToFileURL(bundled).href);
  throw new Error(
    'Playwright was not found. Install it in the project or set PLAYWRIGHT_MODULE to its index.mjs.',
  );
}
async function browserExecutable(chromium) {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (explicit) {
    assert.ok(await exists(explicit), 'PLAYWRIGHT_CHROMIUM_EXECUTABLE does not exist');
    return { executablePath: explicit };
  }
  if (await exists(chromium.executablePath())) return {};
  // A shared runtime may ship a compatible installed browser at a different
  // Playwright revision. Use only an existing local executable; never download.
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
    join(homedir(), '.cache/ms-playwright'),
  ].filter((path) => path && path !== '0');
  for (const cache of caches) {
    if (!(await exists(cache))) continue;
    const revisions = (await readdir(cache))
      .filter((name) => /^chromium_headless_shell-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-').at(-1)) - Number(a.split('-').at(-1)));
    for (const revision of revisions)
      for (const binary of [
        'chrome-headless-shell-win64/chrome-headless-shell.exe',
        'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
      ]) {
        const executablePath = join(cache, revision, binary);
        if (await exists(executablePath)) return { executablePath };
      }
  }
  return {};
}
const { chromium } = await loadPlaywright();
await mkdir(folder, { recursive: true });
await writeFile(
  resolve(folder, 'platform.ts'),
  `
const backup={id:'qa-original',createdAt:'2026-10-24T04:00:00.000Z',byteLength:524288};
export const isNativeApp=()=>true;
export async function nativeLatestRecoveryBackup(){return JSON.parse(localStorage.getItem('qa-backup')||'null')||undefined;}
export async function nativeDownloadRecoveryBackup(id){localStorage.setItem('qa-exported',id);}
export async function nativePreviewSQLiteRestore(file){
 await new Promise(resolve=>setTimeout(resolve,60));
 localStorage.setItem('qa-preview-name',file.name);
 if(file.name.startsWith('invalid'))throw new Error('SQLite 备份校验失败：不是 SQLite 3 数据库文件');
 const bytes=new Uint8Array(await file.arrayBuffer());if(!bytes.length)throw new Error('empty');
 const counts={learning_days:2,learning_task_results:6,focus_sessions:3,document_versions:4,question_drafts:2,question_revisions:5,questions:25,papers:4,documents:3,assets:6,attempts:1,learning_results:7,study:4,study_parts:3,reviews:2,review_cards:3,review_events:8,question_history:7,domains:2,categories:5,tags:4,paper_drafts:1,document_drafts:2,ai_workspace_drafts:3,daily_pushes:1,settings:1,ai_settings:1,ai_runs:9,ai_import_jobs:2,question_feedback:4,quality_scans:2,quality_issues:7};
 return {token:file.name,filename:file.name,byteLength:bytes.length,sha256:'1234567890abcdef'.repeat(4),schemaVersion:1,counts,currentCounts:{questions:8,papers:2,attempts:3},sourceHadAiKey:true,activeExamCount:0};
}
export async function nativeConfirmSQLiteRestore(token){localStorage.setItem('qa-backup',JSON.stringify(backup));if(token.startsWith('fail'))throw new Error('恢复失败，原数据已保留，应用可继续使用。');localStorage.setItem('qa-restored','yes');return {recoveryBackup:backup};}
export async function nativeFetch(){throw new Error('not used in UI mock');}
export async function nativeDownload(){}
export async function saveGeneratedFile(){}
`,
);
await writeFile(
  resolve(folder, 'entry.tsx'),
  `import React from 'react';import {createRoot} from 'react-dom/client';import {SQLiteRestore} from '../../web/features/settings/sqlite-restore';import '../../web/app/styles.css';import '../../web/shared/ui/layout.css';createRoot(document.getElementById('root')!).render(<main style={{maxWidth:900,margin:'32px auto',padding:16}}><SQLiteRestore /></main>);`,
);
const built = resolve(folder, 'built');
await build({
  root,
  configFile: false,
  logLevel: 'error',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [react()],
  resolve: { alias: [{ find: '@platform', replacement: resolve(folder, 'platform.ts') }] },
  publicDir: false,
  build: {
    outDir: built,
    emptyOutDir: true,
    lib: { entry: resolve(folder, 'entry.tsx'), formats: ['es'], fileName: () => 'ui.mjs' },
  },
});
const css = (await readdir(built)).find((file) => file.endsWith('.css'));
// Vite may emit shared JSX/runtime chunks; serve every generated root asset.
const generatedFiles = new Set(await readdir(built));
const server = createServer(async (req, res) => {
  if (req.url === '/ui.mjs') {
    res.setHeader('Content-Type', 'application/javascript');
    res.end(await readFile(resolve(built, 'ui.mjs')));
  } else if (req.url === '/ui.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(css ? await readFile(resolve(built, css)) : '');
  } else if (
    generatedFiles.has(new URL(req.url, 'http://127.0.0.1').pathname.slice(1)) &&
    /\.(?:m?js|css)$/.test(new URL(req.url, 'http://127.0.0.1').pathname)
  ) {
    const name = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
    res.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(await readFile(resolve(built, name)));
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="/ui.css"/><title>恢复界面隔离验证</title></head><body><div id="root"></div><script type="module" src="/ui.mjs"></script></body></html>',
    );
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(await browserExecutable(chromium)) });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:' + port + '/restore-qa');
    await page.getByRole('heading', { name: '从迁移数据库完整恢复' }).waitFor();
    const file = page.getByLabel('选择 SQLite 迁移包或数据库');
    const choose = page.getByRole('button', { name: '选择 SQLite 迁移包或数据库', exact: true });
    await file.setInputFiles({
      name: 'invalid.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('invalid'),
    });
    await page.getByRole('alert').filter({ hasText: '有效ZIP' }).waitFor();
    assert.equal(await choose.isEnabled(), true);
    const rawDatabase = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128)]);
    await file.setInputFiles({
      name: 'raw.sqlite',
      mimeType: 'application/vnd.sqlite3',
      buffer: rawDatabase,
    });
    await page.getByRole('heading', { name: '已通过校验：raw.sqlite', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('qa-preview-name')), 'raw.sqlite');
    assert.equal(
      await page.getByRole('button', { name: '保留当前副本并完整恢复', exact: true }).isDisabled(),
      true,
    );
    await file.setInputFiles({
      name: 'invalid-structure.sqlite',
      mimeType: 'application/vnd.sqlite3',
      buffer: rawDatabase,
    });
    await page.getByRole('alert').filter({ hasText: '不是 SQLite 3 数据库文件' }).waitFor();
    assert.equal(
      await page.getByRole('heading', { name: '已通过校验：raw.sqlite', exact: true }).count(),
      0,
    );
    assert.equal(await page.evaluate(() => localStorage.getItem('qa-restored')), null);
    await file.setInputFiles({
      name: 'invalid-header.sqlite',
      mimeType: 'application/vnd.sqlite3',
      buffer: Buffer.from('corrupt sqlite header'),
    });
    await page.getByRole('alert').filter({ hasText: '文件头无效或文件已损坏' }).waitFor();
    assert.equal(
      await page.evaluate(() => localStorage.getItem('qa-preview-name')),
      'invalid-structure.sqlite',
      'unrecognized raw header never reaches restore validation or replacement',
    );
    assert.equal(await choose.isEnabled(), true);
    await file.setInputFiles({
      name: 'fail.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(
        await buildDataPackage({
          kind: 'sqlite-backup',
          title: '数据库验收',
          payloads: [],
          files: [
            {
              path: 'database/fail.sqlite',
              bytes: Buffer.from('SQLite format 3 mock'),
              mediaType: 'application/vnd.sqlite3',
            },
          ],
        }),
      ),
    });
    await page.getByRole('heading', { name: '已通过校验：fail.zip' }).waitFor();
    const restore = page.getByRole('button', { name: '保留当前副本并完整恢复', exact: true });
    assert.equal(await restore.isDisabled(), true);
    assert.equal(await page.locator('tbody tr').count(), Object.keys(sqliteRecordLabels).length);
    for (const [label, count] of [
      ['题目编辑草稿', 2],
      ['题目修订历史', 5],
      ['每日学习计划', 2],
      ['计划任务进度', 6],
      ['专注复习会话', 3],
      ['资料引用版本', 4],
      ['自适应复习卡片', 3],
      ['自适应复习事件', 8],
      ['每日推荐记录', 1],
      [sqliteRecordLabels.ai_import_jobs, 2],
      ['AI辅助草稿', 3],
      ['题目反馈', 4],
      [sqliteRecordLabels.quality_fingerprints, 0],
    ])
      assert.deepEqual(
        await page
          .getByRole('row')
          .filter({ has: page.getByRole('cell', { name: label, exact: true }) })
          .getByRole('cell')
          .allTextContents(),
        [label, '0', String(count)],
      );
    await page.getByRole('checkbox').check();
    assert.equal(await restore.isEnabled(), true);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      'mobile preview has no horizontal page overflow',
    );
    await page.screenshot({ path: resolve(folder, 'preview-mobile.png'), fullPage: true });
    await restore.click();
    await page.getByRole('alert').filter({ hasText: '原数据已保留' }).waitFor();
    assert.equal(await choose.isEnabled(), true);
    assert.equal(await page.getByRole('heading', { name: '已通过校验：fail.zip' }).count(), 0);
    await page.screenshot({ path: resolve(folder, 'rollback-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '保存或分享恢复前副本' }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('qa-exported')), 'qa-original');
    assert.equal(await page.evaluate(() => localStorage.getItem('qa-restored')), null);
    await page.setViewportSize({ width: 1280, height: 900 });
    await file.setInputFiles({
      name: 'success.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(
        await buildDataPackage({
          kind: 'sqlite-backup',
          title: '数据库验收',
          payloads: [],
          files: [
            {
              path: 'database/success.sqlite',
              bytes: Buffer.from('SQLite format 3 mock'),
              mediaType: 'application/vnd.sqlite3',
            },
          ],
        }),
      ),
    });
    await page.getByRole('heading', { name: '已通过校验：success.zip' }).waitFor();
    await page.getByRole('checkbox').check();
    await page.screenshot({ path: resolve(folder, 'preview-desktop.png'), fullPage: true });
    await Promise.all([
      page.waitForEvent('load'),
      page.getByRole('button', { name: '保留当前副本并完整恢复', exact: true }).click(),
    ]);
    await page.getByRole('button', { name: '保存或分享恢复前副本' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('qa-restored')), 'yes');
    assert.equal(await page.getByRole('checkbox').count(), 0);
    assert.deepEqual(errors, []);
    const report = {
      passed: 8,
      checks: [
        '拒绝无效ZIP包，选择器保持可用',
        '支持SQLite原始数据库，正确识别16字节SQLite3文件头且仍需原生验证和明确确认',
        '拒绝损坏文件头与结构，旧预览清除且原数据不变',
        '预览全部数据类型及题目草稿/修订历史/学习计划/专注复习/资料引用版本/FSRS/每日推荐/教材任务/AI草稿/反馈数量，显式勾选后才允许替换',
        '390px恢复预览无页面横向溢出',
        '恢复失败保持原数据及页面可用，可导出恢复前副本',
        '成功恢复重载页面并保留恢复前副本入口',
        '全程无浏览器异常',
      ],
      browserErrors: errors,
      isolatedNativeBridge: true,
    };
    await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error('Browser errors:', errors);
    console.error('Page snapshot:', await page.locator('body').innerHTML());
    throw error;
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
