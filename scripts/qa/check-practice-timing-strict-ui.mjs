/** Dev React StrictMode uses the same isolated backend as production QA. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const folder = resolve('test-results/practice-timing-strict-ui'); await mkdir(folder, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/qa/serve-practice-timing.ts'], { env: { ...process.env, QA_PRACTICE_DEV: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page; const checks = [], pageErrors = [], unexpectedNetwork = [];
server.stdout.on('data', chunk => stdout += chunk); server.stderr.on('data', chunk => stderr += chunk);
try {
  for (let index = 0; index < 900 && !stdout.includes('PRACTICE_TIMING_READY '); index++) { if (server.exitCode !== null) throw new Error(stderr); await delay(100); }
  const line = stdout.split(/\r?\n/).find(value => value.startsWith('PRACTICE_TIMING_READY ')); assert.ok(line, stdout + stderr); const { origin } = JSON.parse(line.slice('PRACTICE_TIMING_READY '.length));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright'); browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  page = await browser.newPage(); page.setDefaultTimeout(60_000); page.on('pageerror', error => pageErrors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); unexpectedNetwork.push(url.href); return route.abort(); });
  const state = async () => { const response = await page.request.get(origin + '/qa/practice-timing'); assert.ok(response.ok()); return response.json(); };
  const settle = async (check, label) => { for (let index = 0; index < 200; index++) { if (await check()) return; await delay(100); } throw new Error('Timed out: ' + label); };
  const first = await state(), path = origin + `/#/attempts/${first.attemptId}`;
  await page.goto(path, { waitUntil: 'domcontentloaded' }); await page.getByTestId('attempt-clock').waitFor(); await settle(async () => (await state()).attempt.practiceTiming?.running, 'first resume');
  assert.equal((await state()).calls.filter(call => call.action === 'resume').length, 1); await page.waitForTimeout(2200); assert.notEqual(await page.getByTestId('attempt-clock').innerText(), '00:00:00'); checks.push('开发模式React StrictMode首入只创建一次有效计时会话');
  await page.getByRole('link', { name: '返回题集记录', exact: true }).click(); await settle(async () => !(await state()).attempt.practiceTiming.running, 'pause'); const paused = (await state()).attempt.practiceTiming;
  await delay(1200); assert.equal((await state()).attempt.practiceTiming.elapsedMilliseconds, paused.elapsedMilliseconds); checks.push('StrictMode卸载及hash事件重复清理不重复累计，离开时段保持冻结');
  await page.goto(path, { waitUntil: 'domcontentloaded' }); await page.getByTestId('attempt-clock').waitFor(); await settle(async () => (await state()).attempt.practiceTiming.running, 'second resume'); assert.equal((await state()).calls.filter(call => call.action === 'resume').length, 2);
  await page.waitForTimeout(1200); await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await settle(async () => (await state()).attempt.practiceTiming.elapsedMilliseconds > paused.elapsedMilliseconds + 1000, 'continued time'); checks.push('StrictMode再次进入以新session继续累计，手动保存持久化');
  assert.deepEqual(pageErrors, []); assert.deepEqual(unexpectedNetwork, []); checks.push('开发源码和内存API零页面错误、无意外外部请求');
  const report = { passed: checks.length, checks, pageErrors, unexpectedNetwork, database: ':memory:', mode: 'vite-development-react-strict' }; await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: resolve(folder, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(folder, 'failure.json'), JSON.stringify({ error: String(error.stack || error), checks, pageErrors, unexpectedNetwork, stderr }, null, 2)); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); if (server.exitCode === null) await Promise.race([new Promise(done => server.once('exit', done)), delay(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
