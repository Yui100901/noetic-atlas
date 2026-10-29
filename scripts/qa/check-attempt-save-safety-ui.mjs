/** Failed writes must leave the current answer/review mounted and recoverable. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), folder = resolve(root, 'test-results/attempt-save-safety-ui'); await mkdir(folder, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/qa/serve-ai-workflows.ts'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page, dismissUnload = false, unloads = 0;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr += value);
const checks = [], errors = [], external = [], calls = [];
try {
  let initial;
  for (let index = 0; index < 1200; index++) { const line = stdout.split(/\r?\n/).find(line => line.startsWith('AI_WORKFLOWS_READY ')); if (line) { initial = JSON.parse(line.slice('AI_WORKFLOWS_READY '.length)); break; } if (server.exitCode !== null) throw Error(stderr); await delay(100); }
  assert.ok(initial, stderr); const { origin } = initial;
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { if (dialog.type() === 'beforeunload') { unloads++; if (dismissUnload) { dismissUnload = false; return void dialog.dismiss(); } } void dialog.accept(); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); external.push(url.href); return route.abort(); });
  page.on('request', request => { if (request.url().startsWith(origin + '/api/')) calls.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postData() }); });
  const api = async (path, method = 'GET', body) => { const reply = await page.request.fetch(origin + path, { method, ...(body === undefined ? {} : { data: body }) }); assert.ok(reply.ok(), path + ': ' + await reply.text()); return reply.json(); };
  const wait = async (fn, name) => { for (let index = 0; index < 180; index++) { if (await fn()) return; await delay(60); } throw Error('Timed out: ' + name); };
  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, autosaveDebounceMs: 10000 } });
  const paper = await api('/api/papers', 'POST', { title: '保存边界专项', mode: 'manual', questionIds: ['S1'], scoring: { enabled: false } });
  const draft = await api('/api/papers/' + paper.id + '/attempts', 'POST', {});
  const attempt = id => api('/api/attempts/' + id);
  const show = async id => { await page.goto(origin + '/#/attempts/' + id); await page.locator('#exam-1 textarea').waitFor(); };
  const answerInput = () => page.locator('#exam-1 textarea');
  const sideQuestions = () => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: /^知识题库/ });
  const failAnswer = async route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA_SAVE_FAILED', message: '专项：回答保存失败' } }) }) : route.continue();
  const failReview = async route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA_REVIEW_FAILED', message: '专项：阅卷保存失败' } }) }) : route.continue();

  await show(draft.id); await answerInput().fill('这份尚未保存的回答不能丢失');
  await page.route('**/api/attempts/' + draft.id, failAnswer); await sideQuestions().click();
  await page.getByText('专项：回答保存失败', { exact: true }).waitFor(); assert.match(page.url(), new RegExp(draft.id)); assert.equal(await answerInput().inputValue(), '这份尚未保存的回答不能丢失'); assert.equal((await attempt(draft.id)).answers.S1, undefined);
  checks.push('普通作答侧栏导航遇保存失败时保留当前页面、答案和明确错误，不静默丢弃');
  await page.unroute('**/api/attempts/' + draft.id, failAnswer); await sideQuestions().click(); await page.waitForURL(/#\/questions$/);
  assert.equal((await attempt(draft.id)).answers.S1.value, '这份尚未保存的回答不能丢失'); assert.equal(unloads, 0);
  checks.push('修复连接后内部跳转自动保存再离开，无多余确认，草稿确实持久化');

  await page.getByRole('link', { name: '说明事务原子性', exact: true }).click(); await page.getByLabel('我的学习笔记', { exact: true }).waitFor();
  await page.evaluate(id => { location.hash = '#/attempts/' + id; }, draft.id); await answerInput().waitFor(); await answerInput().fill('浏览器返回前的新回答');
  await page.route('**/api/attempts/' + draft.id, failAnswer); await page.goBack(); await page.getByText('专项：回答保存失败', { exact: true }).waitFor();
  await wait(() => page.url().includes(draft.id), 'history restored'); assert.equal(await answerInput().inputValue(), '浏览器返回前的新回答');
  const retainedClock = await page.getByTestId('attempt-clock').innerText();
  assert.equal((await attempt(draft.id)).practiceTiming.running, true);
  await wait(async () => await page.getByTestId('attempt-clock').innerText() !== retainedClock, 'clock still running after cancelled back');
  await page.unroute('**/api/attempts/' + draft.id, failAnswer); await page.goBack(); await page.getByLabel('我的学习笔记', { exact: true }).waitFor(); assert.match(page.url(), /questions\/S1/);
  assert.equal((await attempt(draft.id)).answers.S1.value, '浏览器返回前的新回答'); checks.push('浏览器返回遇失败恢复原历史位置并继续计时，重试成功后回到正确上一页，不增加错误跳转');

  const submitted = await api('/api/attempts/' + draft.id + '/submit', 'POST', { answers: { S1: { value: '整体提交或回滚' } } });
  await show(submitted.id); const verdict = () => page.getByRole('group', { name: 'S1 主观题判定', exact: true });
  await verdict().getByRole('button', { name: '部分正确', exact: true }).click(); await page.locator('.self-score').getByRole('button', { name: '2 · 能独立', exact: true }).click();
  await page.getByLabel('人工阅卷保存状态', { exact: true }).filter({ hasText: '尚未保存' }).waitFor();
  dismissUnload = true; await page.reload({ waitUntil: 'domcontentloaded', timeout: 2000 }).catch(() => undefined); assert.equal(unloads, 1); assert.match(await verdict().getByRole('button', { name: '部分正确', exact: true }).getAttribute('class'), /selected/);
  checks.push('人工判定与掌握自评显示未保存状态，关闭/刷新可取消并保留高亮选择');
  await page.route('**/api/attempts/' + submitted.id + '/review', failReview); await sideQuestions().click(); await page.getByText('专项：阅卷保存失败', { exact: true }).waitFor(); assert.match(page.url(), new RegExp(submitted.id));
  await page.unroute('**/api/attempts/' + submitted.id + '/review', failReview); await sideQuestions().click(); await page.waitForURL(/#\/questions$/);
  const savedReview = await attempt(submitted.id); assert.equal(savedReview.answers.S1.verdict, 'partial'); assert.equal(savedReview.answers.S1.mastery, 2);
  checks.push('人工阅卷离开先保存，失败留页；重试后正误和掌握度均持久化');

  await show(submitted.id);
  await page.getByRole('button', { name: 'AI评价本题', exact: true }).click(); const gradeDialog = page.getByRole('dialog', { name: 'AI评价这道主观题', exact: true });
  await gradeDialog.getByRole('button', { name: '生成 1 题的建议评价', exact: true }).click(); await gradeDialog.getByRole('button', { name: '确认应用选中判题结果', exact: true }).waitFor();
  await gradeDialog.getByRole('button', { name: '关闭', exact: true }).click(); await verdict().getByRole('button', { name: '正确', exact: true }).click(); await page.getByRole('button', { name: 'AI评价本题', exact: true }).click();
  await page.route('**/api/attempts/' + submitted.id + '/review', failReview); const beforeApply = calls.filter(call => /\/ai\/runs\/[^/]+\/apply$/.test(call.path)).length;
  await gradeDialog.getByRole('button', { name: '确认应用选中判题结果', exact: true }).click(); await page.getByText('专项：阅卷保存失败', { exact: true }).waitFor();
  await gradeDialog.getByRole('alert').filter({ hasText: /人工阅卷|自评/ }).waitFor();
  assert.equal(calls.filter(call => /\/ai\/runs\/[^/]+\/apply$/.test(call.path)).length, beforeApply); assert.equal((await attempt(submitted.id)).answers.S1.verdict, 'partial');
  await page.unroute('**/api/attempts/' + submitted.id + '/review', failReview); await gradeDialog.getByRole('button', { name: '确认应用选中判题结果', exact: true }).click();
  await gradeDialog.getByText('作答或人工评分在分析后已变化，请重新请求评价', { exact: true }).waitFor();
  assert.equal((await attempt(submitted.id)).answers.S1.verdict, 'correct');
  await gradeDialog.getByRole('button', { name: '生成 1 题的建议评价', exact: true }).click();
  await wait(async () => await gradeDialog.getByRole('button', { name: '确认应用选中判题结果', exact: true }).isEnabled(), 're-generated grade');
  await gradeDialog.getByRole('button', { name: '确认应用选中判题结果', exact: true }).click();
  await wait(async () => (await attempt(submitted.id)).answers.S1.verdict === 'partial', 'AI applied after regeneration');
  const reviewCall = calls.findLastIndex(call => call.path === '/api/attempts/' + submitted.id + '/review' && call.body?.includes('correct'));
  const applyCall = calls.findLastIndex(call => /\/ai\/runs\/[^/]+\/apply$/.test(call.path)); assert.ok(reviewCall >= 0 && applyCall > reviewCall);
  await gradeDialog.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByLabel('人工阅卷保存状态', { exact: true }).filter({ hasText: '已保存' }).waitFor();
  checks.push('AI应用前先保存人工输入，失败不发送AI应用；保存新版本使旧评价过期并明确提示，重新生成后才能应用');

  await verdict().getByRole('button', { name: '错误', exact: true }).click();
  const gradeBefore = calls.filter(call => call.path === '/api/ai/grade').length;
  await page.getByRole('button', { name: 'AI评价本题', exact: true }).click();
  await gradeDialog.getByRole('button', { name: '生成 1 题的建议评价', exact: true }).click();
  await wait(async () => calls.filter(call => call.path === '/api/ai/grade').length > gradeBefore && await gradeDialog.getByRole('button', { name: '生成 1 题的建议评价', exact: true }).isEnabled(), 'fresh grade after manual save');
  assert.equal((await attempt(submitted.id)).answers.S1.verdict, 'incorrect');
  await gradeDialog.getByRole('button', { name: '确认应用选中判题结果', exact: true }).click();
  await wait(async () => (await attempt(submitted.id)).answers.S1.verdict === 'partial', 'fresh grade applied');
  await gradeDialog.getByRole('button', { name: '关闭', exact: true }).click();
  checks.push('生成AI评价前保存人工输入，以最新持久化版本分析，常规生成→应用不产生版本冲突');

  const scoredPaper = await api('/api/papers', 'POST', { title: '评分保存边界', mode: 'manual', questionIds: ['S1'], scoring: { enabled: true, totalPoints: 5, questionPoints: { S1: 5 } } });
  const scored = await api('/api/papers/' + scoredPaper.id + '/attempts', 'POST', {}); await api('/api/attempts/' + scored.id + '/submit', 'POST', { answers: { S1: { value: '整体提交' } } });
  await show(scored.id); await page.getByLabel('S1 人工得分', { exact: true }).fill('7'); await sideQuestions().click(); await page.getByText(/得分需为 0–5 分/).waitFor(); assert.match(page.url(), new RegExp(scored.id)); assert.equal(await page.getByLabel('S1 人工得分', { exact: true }).inputValue(), '7');
  await page.getByLabel('S1 人工得分', { exact: true }).fill('0'); await sideQuestions().click(); await page.waitForURL(/#\/questions$/); assert.equal((await attempt(scored.id)).answers.S1.selfScore, 0);
  checks.push('非法人工分数阻止离开且保留输入，改为0分后可保存离开，不混同未评');

  await page.goto(origin + '/#/quick'); await page.getByRole('button', { name: '随机抽一题', exact: true }).waitFor(); await page.getByRole('button', { name: '随机抽一题', exact: true }).click(); await page.locator('.quick-current-attempt .exam-question').first().waitFor();
  const quickId = await page.locator('.quick-current-attempt').getAttribute('data-attempt-id');
  const quickInput = page.locator('.quick-current-attempt textarea');
  if (await quickInput.count()) await quickInput.fill('抽下一题前必须保存'); else await page.locator('.quick-current-attempt input[type=radio]').first().check();
  await page.route('**/api/attempts/' + quickId, failAnswer); const beforeDraw = calls.filter(call => call.path === '/api/quick-practice').length;
  await page.getByRole('button', { name: '重新随机一题', exact: true }).click(); await page.getByText('当前回答或阅卷尚未保存，请在下方重试后继续抽题。', { exact: true }).waitFor();
  assert.equal(await page.locator('.quick-current-attempt').getAttribute('data-attempt-id'), quickId); assert.equal(calls.filter(call => call.path === '/api/quick-practice').length, beforeDraw);
  await page.unroute('**/api/attempts/' + quickId, failAnswer);
  let releaseDraw, drawSeen = false; const drawGate = new Promise(done => releaseDraw = done);
  const failDraw = async route => { drawSeen = true; await drawGate; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'QA_DRAW_FAILED', message: '专项：新题抽取失败' } }) }); };
  await page.route('**/api/quick-practice', failDraw); await page.getByRole('button', { name: '重新随机一题', exact: true }).click();
  await wait(() => drawSeen, 'draw pending after answer saved'); assert.ok(Object.keys((await attempt(quickId)).answers).length);
  if (await quickInput.count()) assert.equal(await quickInput.isDisabled(), true); else assert.equal(await page.locator('.quick-current-attempt input[type=radio]').first().isDisabled(), true);
  releaseDraw(); await page.getByText('专项：新题抽取失败', { exact: true }).waitFor(); assert.equal(await page.locator('.quick-current-attempt').getAttribute('data-attempt-id'), quickId);
  if (await quickInput.count()) assert.equal(await quickInput.isEnabled(), true); else assert.equal(await page.locator('.quick-current-attempt input[type=radio]').first().isEnabled(), true);
  checks.push('抽新题等待期间冻结旧输入，新题请求失败仍留在原题并恢复编辑');
  await page.unroute('**/api/quick-practice', failDraw); await page.getByRole('button', { name: '重新随机一题', exact: true }).click(); await wait(async () => await page.locator('.quick-current-attempt').getAttribute('data-attempt-id') !== quickId, 'next draw'); assert.ok(Object.keys((await attempt(quickId)).answers).length);
  checks.push('重新随机一题等待旧答案保存，失败不创建新草稿；成功保留旧答案后替换');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); checks.push('零页面异常和外部请求，全部使用隔离内存数据与本机确定模型');
  await page.screenshot({ path: resolve(folder, 'save-safety.png'), fullPage: true });
  await rm(resolve(folder, 'failure.json'), { force: true }); await rm(resolve(folder, 'failure.png'), { force: true });
  await writeFile(resolve(folder, 'report.json'), JSON.stringify({ passed: checks.length, checks, errors, external, database: ':memory:' }, null, 2)); console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) { await page?.screenshot({ path: resolve(folder, 'failure.png'), fullPage: true }).catch(() => undefined); await writeFile(resolve(folder, 'failure.json'), JSON.stringify({ error: String(error.stack || error), checks, errors, external, stderr }, null, 2)); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); if (server.exitCode === null) await Promise.race([new Promise(done => server.once('exit', done)), delay(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
