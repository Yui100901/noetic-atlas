import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../server/index.js';

// Isolated fixture only; the real user's database is never opened by this script.
const fixture = await mkdtemp(join(tmpdir(), 'noetic-exam-ui-'));
const databasePath = join(fixture, 'qa.sqlite'); const output = resolve('test-results/exam-timing-ui'); await mkdir(output, { recursive: true });
const app = await buildApp({ databasePath, seedPath: join(fixture, 'missing-seed.json'), staticRoot: process.env.QA_WEB_ROOT || resolve('dist/web') });
await app.listen({ host: '127.0.0.1', port: 4355 });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const consoleErrors: string[] = [], checks: string[] = [];
page.setDefaultNavigationTimeout(60000); page.on('pageerror', error => consoleErrors.push(error.message)); page.on('dialog', dialog => dialog.accept());
async function api(path: string, method = 'GET', body?: unknown): Promise<any> { const response = await fetch(`http://127.0.0.1:4355${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; }
try {
  const question = (id: string, type: string = 'true_false') => ({ id, title: id, type, stemMarkdown: `计时测试 ${id}`, answerMarkdown: '参考', explanationMarkdown: '解析', options: [], correctAnswers: type === 'true_false' ? ['true'] : [], difficulty: 1, depth: 1, frequency: 1, frequencyScope: '', frequencyBasis: '', collection: 'general', status: 'published', categoryIds: [], tagIds: [], sourceRefs: [], sourceDocument: null, sourceAnchor: null });
  await api('/api/import', 'POST', { mode: 'merge', data: { schemaVersion: 1, generatedAt: new Date().toISOString(), domains: [], categories: [], tags: [], documents: [], papers: [], questions: ['T', 'F', 'U'].map(id => question(id)).concat(question('S', 'short_answer')) } });
  const paper = await api('/api/papers', 'POST', { title: '计时及答题卡验收卷', mode: 'manual', questionIds: ['T', 'F', 'U', 'S'], scoring: { enabled: true, questionPoints: { T: 2, F: 2, U: 2, S: 4 } } });
  await page.goto(`http://127.0.0.1:4355/#/papers/${paper.id}`, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: '开始练习', exact: true }).click(); await page.locator('[data-testid="attempt-clock"]').waitFor();
  await page.locator('#exam-1 input[type="radio"]').first().check(); await page.locator('#exam-2 input[type="radio"]').last().check(); await page.locator('#exam-4 textarea').fill('这里是主观题答案');
  await page.waitForTimeout(2200); assert.notEqual(await page.getByTestId('attempt-clock').innerText(), '00:00:00'); assert.equal(await page.locator('.question-navigator [data-answer-state="answered"]').count(), 3); checks.push('普通练习顺计时与已答/未答状态');
  await page.locator('.navigator-submit').click(); await page.getByLabel('本次作答时间').waitFor(); assert.equal(await page.locator('.question-navigator [data-answer-state="correct"]').count(), 1); assert.equal(await page.locator('.question-navigator [data-answer-state="incorrect"]').count(), 1); assert.equal(await page.locator('.question-navigator [data-answer-state="unanswered"]').count(), 1); assert.equal(await page.locator('.question-navigator [data-answer-state="ungraded"]').count(), 1); checks.push('答题卡交卷按钮与四态判分');
  await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(600); await page.screenshot({ path: join(output, 'desktop-answer-states.png'), fullPage: true });
  const normalId = page.url().split('/').at(-1)!; assert.ok((await api(`/api/attempts/${normalId}`)).elapsedSeconds >= 2);
  await page.goto(`http://127.0.0.1:4355/#/papers/${paper.id}`, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: '选择练习模式', exact: true }).click(); await page.getByRole('menuitem', { name: '考试模式', exact: true }).click(); assert.equal(await page.getByLabel('考试时长（分钟）').inputValue(), '120'); await page.getByLabel('考试时长（分钟）').fill('1'); await page.getByRole('button', { name: '开始考试', exact: true }).click(); await page.getByLabel('考试倒计时').waitFor();
  const examId = page.url().split('/').at(-1)!; const examHash = `#/attempts/${examId}`;
  await page.locator('.sidebar nav a[href="#/documents"]').click(); assert.equal(await page.evaluate(() => location.hash), examHash); await page.evaluate(() => { location.hash = '#/taxonomy'; }); await page.waitForTimeout(300); assert.equal(await page.evaluate(() => location.hash), examHash); checks.push('考试默认120分钟、可改时长与全局导航锁');
  await page.locator('#exam-1 input[type="radio"]').first().check(); await page.waitForTimeout(800); await page.reload(); await page.getByLabel('考试倒计时').waitFor(); assert.ok(await page.locator('#exam-1 input[type="radio"]').first().isChecked()); checks.push('刷新恢复考试与已保存答案');
  await page.locator('.navigator-submit').click(); await page.getByLabel('本次作答时间').waitFor(); await page.locator('.sidebar nav a[href="#/documents"]').click(); await page.waitForURL('**/#/documents'); checks.push('提前交卷释放导航锁');
  const overdue = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 1 }); await api(`/api/attempts/${overdue.id}`, 'PUT', { answers: { T: { value: 'true' } } });
  // Move only the isolated fixture's clock record into the past, simulating app sleep.
  const db = new DatabaseSync(databasePath); const row = db.prepare('SELECT data FROM attempts WHERE id=?').get(overdue.id) as { data: string }; const stored = JSON.parse(row.data); stored.startedAt = new Date(Date.now() - 62000).toISOString(); stored.deadlineAt = new Date(Date.parse(stored.startedAt) + 60000).toISOString(); db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify(stored), overdue.id); db.close();
  await page.goto(`http://127.0.0.1:4355/#/attempts/${overdue.id}`, { waitUntil: 'domcontentloaded' }); await page.getByLabel('本次作答时间').waitFor(); const completed = await api(`/api/attempts/${overdue.id}`); assert.equal(completed.autoSubmitted, true); assert.equal(completed.elapsedSeconds, 60); assert.equal(completed.answers.T.value, 'true'); checks.push('离线/后台逾时恢复后自动交卷并封存答案');
  if (process.env.QA_REAL_EXAM_EXPIRY === '1') {
    const live = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 1 });
    await page.goto(`http://127.0.0.1:4355/#/attempts/${live.id}`, { waitUntil: 'domcontentloaded' }); await page.getByLabel('考试倒计时').waitFor();
    await page.locator('#exam-1 input[type="radio"]').first().check();
    await page.getByLabel('本次作答时间').waitFor({ timeout: 70000 });
    const liveResult = await api(`/api/attempts/${live.id}`); assert.equal(liveResult.autoSubmitted, true); assert.equal(liveResult.elapsedSeconds, 60); assert.equal(liveResult.answers.T.value, 'true'); checks.push('真实60秒前台倒计时到时自动交卷');
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(600); await page.screenshot({ path: join(output, 'mobile-answer-states.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); checks.push('390px移动端无横向溢出');
  assert.deepEqual(consoleErrors, []); await writeFile(join(output, 'report.json'), JSON.stringify({ checks, consoleErrors }, null, 2)); process.stdout.write(JSON.stringify({ passed: checks.length, report: join(output, 'report.json') }));
} finally { await browser.close(); await app.close(); assert.equal(resolve(fixture).startsWith(resolve(tmpdir())), true); await rm(fixture, { recursive: true, force: true }); }
