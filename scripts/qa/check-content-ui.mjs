/** Run after generating content packs and npm run build. Only uses an in-memory server. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'test-results/content');
let chromium;
try { ({ chromium } = await (process.env.PLAYWRIGHT_MODULE ? import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href) : import('playwright'))); }
catch (error) { throw new Error('内容UI验收需要Playwright及可用浏览器；请在QA环境安装，或通过PLAYWRIGHT_MODULE指定已有的Playwright入口文件。', { cause: error }); }
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/qa/serve-content.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = '', stderr = '', browser;
server.stdout.on('data', chunk => { stdout += chunk; });
server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
const checks = [], pageErrors = [], artifacts = [];
await mkdir(output, { recursive: true });
try {
  let ready;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.exitCode !== null) throw new Error(`Content fixture exited ${server.exitCode}: ${stderr}`);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('CONTENT_UI_READY '));
    if (line) { ready = JSON.parse(line.slice('CONTENT_UI_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(ready, `Content fixture readiness timed out: ${stderr}`);
  const origin = ready.origin;
  async function api(path, method = 'GET', body) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(20000), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  const fixture = await api('/qa/content-fixture');
  checks.push(...fixture.checks);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  const snapshot = async name => { const file = `${name}.png`; await page.screenshot({ path: resolve(output, file), fullPage: false }); artifacts.push(file); };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow at ${page.url()}`);
  async function question(id) {
    await page.goto(`${origin}/#/questions/${encodeURIComponent(id)}`);
    await page.locator('.question-body').waitFor();
    await page.getByRole('button', { name: '我想过了，展开答案与解析', exact: true }).click();
    await page.locator('#reference-answer').waitFor();
    await page.locator('#reference-answer').evaluate(element => element.scrollIntoView({ block: 'start' }));
    return await page.locator('#reference-answer').innerText();
  }
  await page.goto(`${origin}/#/papers`);
  await page.getByLabel('显示已归档').check();
  const card = page.locator('.paper-card').filter({ hasText: '英语单词表 001' });
  await card.waitFor();
  assert.match(await card.innerText(), /已归档/);
  assert.match(await card.innerText(), /无分练习/);
  assert.match(await card.innerText(), /100/);
  checks.push('桌面练习工作室展示归档的100词无分词表');
  await snapshot('archived-wordlist-desktop');
  const english = await question(fixture.englishId);
  assert.match(english, /英文|English/i); assert.match(english, /中文/); assert.match(english, /例句|用例/);
  checks.push('英语词卡显示中英释义和具体来源例句');
  await snapshot('english-card-desktop');
  const japanese = await question(fixture.japaneseId);
  assert.match(japanese, /AI|LLM/); assert.match(japanese, /人工|审核/);
  checks.push('日语词卡保留上游AI生成和人工审核提示');
  await snapshot('japanese-card-desktop');
  const chinese = await question(fixture.chineseId);
  assert.match(chinese, /缺失|待补全/);
  checks.push('成语词卡明确展示缺失典故或出处提示');
  await snapshot('chinese-card-desktop');
  await question(fixture.drivingId);
  const image = page.locator('.question-body img').first();
  await image.waitFor();
  await image.evaluate(element => element.decode());
  assert.ok(await image.evaluate(element => element.naturalWidth > 0 && element.naturalHeight > 0));
  await image.evaluate(element => element.scrollIntoView({ block: 'center' }));
  checks.push('驾驶题托管PNG正常解码并显示');
  await snapshot('driving-image-desktop');
  for(const name of ['chemistry-inorganic','chemistry-organic']){
    const body=await question(fixture[name]);assert.match(body,/性质|物性/);assert.match(body,/反应/);assert.match(body,/用途/);
    checks.push(name+'卡片展示性质、反应与用途');await snapshot(name+'-desktop');
  }
  const medicine=await question(fixture.pharmacology);assert.match(medicine,/机制|药理/);assert.match(medicine,/警示|风险|安全/);
  checks.push('药物卡片展示药理与安全边界');await snapshot('pharmacology-desktop');
  const historical=await question(fixture.historicalId);assert.match(historical,/当前适用性核验/);assert.match(historical,/现行官方依据/);
  assert.ok(await page.getByText('已确认含失效内容',{exact:true}).count());
  checks.push('历史题发布后仍显著展示失效标签及现行依据');await snapshot('historical-validity-desktop');
  await page.goto(`${origin}/#/questions/review`);
  await page.getByLabel('审核题目领域').selectOption('japanese');
  await page.getByText('4 道待审核题目', { exact: true }).waitFor();
  assert.equal(await page.locator('.review-item').count(), 4);
  await page.getByLabel('审核题目领域').selectOption('english');
  await page.getByText('1 道待审核题目', { exact: true }).waitFor();
  checks.push('待审核列表按领域筛选正确，不混入已审核英语词条');
  await snapshot('pending-domain-filter');
  await page.setViewportSize({ width: 390, height: 844 });
  await question(fixture.englishId); await noOverflow(); await snapshot('english-card-mobile');
  await question(fixture.japaneseId); await noOverflow(); await snapshot('japanese-card-mobile');
  await question(fixture.chineseId); await noOverflow(); await snapshot('chinese-card-mobile');
  await question(fixture.drivingId); await noOverflow();
  await page.locator('.question-body img').first().evaluate(async element => { element.scrollIntoView({ block: 'center' }); await element.decode(); });
  assert.ok(await page.locator('.question-body img').first().evaluate(element => element.naturalWidth > 0));
  await snapshot('driving-image-mobile');
  checks.push('390px词卡及驾驶图片均无页面横向溢出');
  for(const id of [fixture['chemistry-inorganic'],fixture['chemistry-organic'],fixture.pharmacology,fixture.historicalId]){await question(id);await noOverflow();}
  checks.push('390px化学、药学和时效标记均无横向溢出');await snapshot('pharmacology-mobile');
  const oldPaper = await api(`/api/papers/${fixture.paperId}`);
  const restored = await api(`/api/papers/${fixture.paperId}`, 'PUT', { id: oldPaper.id, title: oldPaper.title, description: oldPaper.description, mode: 'manual', organization: 'domain', domainId: 'english', questionIds: fixture.englishWordIds, scoring: { enabled: false } });
  assert.equal(restored.archived, false);
  assert.equal(restored.scoring.enabled, false);
  checks.push('审核后通过正式保存接口恢复100词无分卷');
  await page.goto(`${origin}/#/papers/${fixture.paperId}`);
  await page.getByRole('button', { name: '开始练习', exact: true }).click();
  await page.waitForURL(/#\/attempts\//);
  await page.getByLabel('练习顺计时').waitFor();
  const attemptId = decodeURIComponent(page.url().split('/').at(-1));
  await page.getByLabel('我的回答', { exact: true }).first().fill('give up; 放弃。This is my isolated review answer.');
  await page.waitForFunction(() => /[1-9]/.test(document.querySelector('[data-testid="attempt-clock"]')?.textContent || ''), undefined, { timeout: 5000 });
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().click();
  await page.getByLabel('本次作答时间').waitFor();
  const submitted = await api(`/api/attempts/${encodeURIComponent(attemptId)}`);
  assert.equal(submitted.status, 'submitted');
  assert.ok(submitted.elapsedSeconds >= 1);
  assert.equal(submitted.scoring.enabled, false);
  checks.push('100词普通练习顺计时、作答和提交用时记录正确');
  await snapshot('wordlist-submitted-mobile');
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`${origin}/#/papers/${fixture.paperId}`);
  await page.getByRole('button', { name: '导出题集', exact: true }).click();
  await page.getByRole('radio', { name: /附答案卷/ }).check();
  await page.getByRole('radio', { name: /Markdown/ }).check();
  const [markdownDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载文件', exact: true }).click()]);
  const markdownPath = resolve(output, 'wordlist-100-answers.md');
  await markdownDownload.saveAs(markdownPath);
  const markdown = await readFile(markdownPath, 'utf8');
  assert.match(markdown, /无分练习/); assert.match(markdown, /abandon/); assert.match(markdown, /参考答案|英文释义/);
  checks.push('真实浏览器下载100词附答案Markdown卷'); artifacts.push('wordlist-100-answers.md');
  await page.getByRole('radio', { name: /PDF 文档/ }).check();
  const [pdfDownload] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: '下载文件', exact: true }).click()]);
  const pdfPath = resolve(output, 'wordlist-100-answers.pdf'); await pdfDownload.saveAs(pdfPath);
  const pdf = await readFile(pdfPath); assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-'); assert.ok(pdf.length > 10000);
  checks.push('真实浏览器生成并下载100词附答案中文PDF卷'); artifacts.push('wordlist-100-answers.pdf');
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  checks.push('全部验收页面无未捕获JavaScript异常');
  await rm(resolve(output, 'failure.json'), { force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ passed: checks.length, checks, pageErrors, artifacts, database: ':memory:', sourceQuestions: 116 }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, output }, null, 2));
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ error: String(error.stack || error), checks, pageErrors, fixtureLog: stderr }, null, 2));
  throw error;
} finally {
  await browser?.close(); server.kill('SIGTERM');
  if (server.exitCode === null) await Promise.race([new Promise(resolveExit => server.once('exit', resolveExit)), delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}
