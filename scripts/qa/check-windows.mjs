/** Exercise the actual portable EXE, without any system Node on its PATH. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { assertCleanBaseConfiguration, assertEmptyInstallation, createReviewedReleaseQuestion, completeReleasePaper } from './release-fixture.mjs';

assert.equal(process.platform, 'win32', 'Windows portable acceptance must run on Windows');
const root = resolve(import.meta.dirname, '../..');
const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const executable = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) || join(root, 'artifacts/windows/noetic-atlas-win32-x64/noetic-atlas.exe'));
assert.ok(existsSync(executable), 'Portable EXE missing: run npm run release -- windows first');
const portableFolder = dirname(executable);
const defaults = JSON.parse(await readFile(join(portableFolder, 'config/defaults.json'), 'utf8'));
assertCleanBaseConfiguration(defaults);
assert.ok(!existsSync(join(portableFolder, 'resources/server/data')), 'Portable resources must not contain a question data directory');
const manifest = JSON.parse(await readFile(join(portableFolder, 'release-manifest.json'), 'utf8'));
assert.equal(manifest.dataBoundary?.installation, 'empty-install');
assert.equal(manifest.dataBoundary?.includesQuestionData, false);
for (const name of ['questions', 'domains', 'categories', 'tags']) assert.equal(manifest.counts[name], 0, `Software manifest ${name} must be zero`);
const playwright = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
assert.ok(playwright._electron, 'The selected Playwright runtime has no Electron support');
const output = join(root, 'test-results/windows-smoke'); await mkdir(output, { recursive: true });
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, 'noetic-windows-smoke-'));
const dataDirectory = join(temporary, 'data');
const downloaded = join(temporary, 'portable-export.json');
const checks = [];
const errors = [];
let electronApp, page, origin, processId, failure;

const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
const systemPath = join(windowsRoot, 'System32');
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (name.toLowerCase() === 'path' || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'NOETIC_DESKTOP_RESOURCES', 'NOETIC_ATLAS_DATA_DIR'].includes(name)) delete environment[name];
}
environment.PATH = systemPath;
environment.NOETIC_ATLAS_DATA_DIR = dataDirectory;

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until(check, message, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(150); }
  throw new Error(message);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
async function portClosed(address) {
  try { await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(700) }); return false; } catch { return true; }
}
async function api(path, method = 'GET', body) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json();
}
async function start() {
  electronApp = await playwright._electron.launch({ executablePath: executable, env: environment, timeout: 60000 });
  processId = electronApp.process().pid;
  page = await electronApp.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  origin = new URL(page.url()).origin;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const runtime = await electronApp.evaluate(({ app }) => ({ execPath: process.execPath, version: app.getVersion(), dataDirectory: app.getPath('userData'), path: process.env.PATH || process.env.Path }));
  assert.equal((await realpath(runtime.execPath)).toLowerCase(), (await realpath(executable)).toLowerCase());
  assert.equal(runtime.version, project.version);
  assert.equal(runtime.path.toLowerCase(), systemPath.toLowerCase());
  assert.equal(resolve(runtime.dataDirectory).toLowerCase(), join(dataDirectory, 'desktop').toLowerCase());
}
async function close() {
  if (!electronApp) return;
  const current = electronApp, oldOrigin = origin, oldPid = processId;
  await current.close();
  electronApp = undefined; page = undefined;
  await until(async () => !alive(oldPid), 'Portable application process did not exit after close', 15000);
  if (oldOrigin) await until(() => portClosed(oldOrigin), 'Portable server port remains open after close', 15000);
}

try {
  // where.exe is from System32. A result here would invalidate the portability
  // check, even if the desktop launcher happened to use its bundled executable.
  let systemNodePresent = false;
  try { systemNodePresent = execFileSync(join(systemPath, 'where.exe'), ['node.exe'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0; }
  catch (error) { if (error.status !== 1) throw error; }
  assert.equal(systemNodePresent, false, 'System-only PATH unexpectedly contains Node');
  await start(); checks.push('实际打包EXE启动，PATH仅含Windows系统目录，无需安装Node');
  await assertEmptyInstallation(api, defaults);
  await page.screenshot({ path: join(output, 'home.png'), fullPage: true });
  checks.push('零题目、零领域分类标签、零用户记录，软件只带基础配置且AI关闭无密钥');
  const renderer = await page.evaluate(() => ({ require: typeof globalThis.require, process: typeof globalThis.process, electron: typeof globalThis.electron }));
  assert.deepEqual(renderer, { require: 'undefined', process: 'undefined', electron: 'undefined' });
  const preferences = await electronApp.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, webviewTag: preferences.webviewTag };
  });
  assert.deepEqual(preferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
  assert.equal(await page.evaluate(() => window.open('https://example.com', '_blank') === null), true, 'External popup was not denied');
  assert.equal(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  checks.push('Renderer隔离与sandbox有效，无Node或Electron接口暴露');

  const question = await createReviewedReleaseQuestion(api);
  const { attempt } = await completeReleasePaper(api, question);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '知识题库', exact: false }).click();
  const firstQuestion = page.locator('.question-row .question-title').first();
  await firstQuestion.waitFor();
  const questionHref = await firstQuestion.getAttribute('href');
  assert.match(questionHref, /^#\/questions\//);
  const questionId = decodeURIComponent(questionHref.replace(/^#\/questions\//, ''));
  assert.equal(questionId, question.id);
  await firstQuestion.click();
  const notes = page.getByRole('textbox', { name: '我的学习笔记' }); await notes.waitFor();
  const note = 'Windows portable acceptance: notes survive application restart.';
  await notes.fill(note);
  const noteSaved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/study/${encodeURIComponent(questionId)}` && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  assert.equal((await noteSaved).status(), 200);
  await page.getByRole('status').filter({ hasText: '学习记录已保存' }).waitFor();
  await page.screenshot({ path: join(output, 'question-note.png'), fullPage: true });
  checks.push('隔离临时库新增、审核、组题提交计分、题库导航和笔记保存正常');

  // QA intercepts only the native save destination in the main process; the
  // production runtime's origin validation and download handling still execute.
  await electronApp.evaluate(({ BrowserWindow }, savePath) => {
    globalThis.__noeticSmokeDownload = { started: false, done: false, state: '' };
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      globalThis.__noeticSmokeDownload.started = true;
      item.setSavePath(savePath);
      item.once('done', (_event, state) => { globalThis.__noeticSmokeDownload.done = true; globalThis.__noeticSmokeDownload.state = state; });
    });
  }, downloaded);
  await page.evaluate(async () => {
    const response = await fetch('/api/export');
    if (!response.ok) throw new Error(`Desktop export failed (${response.status})`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = 'portable-export.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  await until(() => electronApp.evaluate(() => globalThis.__noeticSmokeDownload.done), 'Electron Blob download did not finish');
  assert.equal(await electronApp.evaluate(() => globalThis.__noeticSmokeDownload.state), 'completed');
  const exported = JSON.parse(await readFile(downloaded, 'utf8'));
  assert.equal(exported.questions.length, 1);
  assert.equal(exported.questions[0].id, question.id);
  assert.ok(exported.attempts.some(item => item.id === attempt.id && item.status === 'submitted' && item.objectiveScore === 2));
  assert.ok(exported.study.some(item => item.questionId === questionId && item.notes === note));
  checks.push('真实/api/export转Blob下载完成，JSON包含题库与已保存笔记');

  await close(); checks.push('窗口关闭后应用进程退出，本地服务端口释放');
  await start();
  await page.evaluate(href => { location.hash = href; }, questionHref);
  const restored = page.getByRole('textbox', { name: '我的学习笔记' }); await restored.waitFor();
  await until(async () => await restored.inputValue() === note, 'Saved learning note was not restored after desktop restart');
  assert.equal((await api('/api/bootstrap')).stats.totalQuestions, 1);
  assert.equal((await api(`/api/attempts/${encodeURIComponent(attempt.id)}`)).status, 'submitted');
  checks.push('发布版重启后保留临时题目、交卷与笔记，不注入初装题库');
  await close(); assert.deepEqual(errors, [], 'Renderer emitted errors');
} catch (error) { failure = error; }
finally {
  try { await close(); }
  catch (error) {
    failure ||= error;
    if (processId && alive(processId)) {
      try { execFileSync(join(systemPath, 'taskkill.exe'), ['/PID', String(processId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
      catch (killError) { if (alive(processId)) failure = new AggregateError([failure, killError], 'Portable QA process cleanup failed'); }
    }
  }
  const target = resolve(temporary); assert.equal(dirname(target), temporaryRoot); assert.ok(basename(target).startsWith('noetic-windows-smoke-'));
  try { await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }); }
  catch (error) { failure ||= error; }
  await writeFile(join(output, 'report.json'), JSON.stringify({ version: project.version, artifact: basename(executable), passed: checks.length, checks, status: failure ? 'failed' : 'passed', ...(failure ? { error: failure.message } : {}) }, null, 2));
}
if (failure) throw failure;
process.stdout.write(JSON.stringify({ version: project.version, passed: checks.length, status: 'passed', screenshots: 'test-results/windows-smoke' }) + '\n');
