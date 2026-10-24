/** Real public packs run exclusively inside a disposable in-memory application. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'test-results/foundations-ui');
const packIds = ['english-grammar-foundations-202610', 'japanese-grammar-foundations-202610', 'chinese-basics-foundations-202610', 'chemistry-basics-foundations-202610', 'medicine-basics-foundations-202610', 'driving-safety-foundations-202610', 'computer-foundations-202610', 'geography-foundations', 'physics-foundations', 'psychology-foundations', 'economics-foundations'];
const packs = await Promise.all(packIds.map(async id => JSON.parse(await readFile(resolve(root, 'data/content-packs', id + '.json'), 'utf8'))));
const originals = packs.flatMap(pack => pack.questions);
assert.equal(originals.length, 781);
assert.equal(new Set(originals.map(question => question.id)).size, 781);
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {validatePack,validatePackSet} from './scripts/content/manage.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
const names=${JSON.stringify(packIds)};
const packs=await Promise.all(names.map(async name=>validatePack(JSON.parse(await readFile('data/content-packs/'+name+'.json','utf8')))));
validatePackSet(packs);
const staging=new Store(':memory:');
for(const pack of packs)importData(staging,pack);
const questions=staging.all('questions');assert.equal(questions.length,781);assert.ok(questions.every(q=>q.status==='pending'));
const app=await buildApp({databasePath:':memory:',seedPath:'no-foundations-ui-seed',staticRoot:'dist/web',logger:false});
const response=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:exportData(staging)}});assert.ok(response.statusCode<400,response.body);staging.db.close();
const origin=await app.listen({host:'127.0.0.1',port:0});
console.log('FOUNDATIONS_READY '+JSON.stringify({origin,questions:questions.length}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value);
server.stderr.on('data', value => stderr = (stderr + value).slice(-15000));
const checks = [], browserErrors = [], externalRequests = [], measurements = [], domainCounts = [], practiced = [];
try {
  let state;
  for (let index = 0; index < 300; index++) {
    if (server.exitCode !== null) throw Error('Memory fixture failed: ' + stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('FOUNDATIONS_READY '));
    if (line) { state = JSON.parse(line.slice('FOUNDATIONS_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr);
  const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    assert.ok(response.ok(), path + ': ' + await response.text()); return response.json();
  };
  let navigation = 0;
  const go = async path => { await page.goto(origin + '/?foundations-ui=' + ++navigation + '#/' + path); await page.locator('.page-header').waitFor(); await page.waitForLoadState('networkidle'); };
  const noOverflow = async label => {
    const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    measurements.push({ label, ...size }); assert.ok(size.width <= size.viewport + 1, label + ': ' + JSON.stringify(size));
  };
  const capture = async label => { await noOverflow(label); await page.screenshot({ path: resolve(output, label + '.png'), fullPage: true }); };
  const bootstrap = await api('/api/bootstrap');
  assert.equal(bootstrap.domains.length, 11);
  assert.equal((await api('/api/questions?status=pending&pageSize=200')).total, 781);
  assert.equal((await api('/api/questions?pageSize=20')).total, 0);
  const allCategories = new Map(bootstrap.categories.map(category => [category.id, category]));
  const allTags = new Map(bootstrap.tags.map(tag => [tag.id, tag]));
  for (const question of originals) {
    assert.ok(question.categoryIds.length && question.tagIds.length);
    const domains = new Set(question.categoryIds.map(id => { assert.ok(allCategories.has(id), 'missing category ' + id); return allCategories.get(id).domainId; }));
    for (const tagId of question.tagIds) { assert.ok(allTags.has(tagId), 'missing tag ' + tagId); const tag = allTags.get(tagId); assert.ok(!tag.domainId || domains.has(tag.domainId)); }
  }
  checks.push('11个真实新增包共781道唯一待审核题；分类和标签依赖完整，默认正式题库为0');
  for (const domain of bootstrap.domains) {
    const result = await api('/api/questions?status=pending&domainId=' + encodeURIComponent(domain.id) + '&pageSize=200');
    assert.ok(result.total > 0, domain.id);
    const question = originals.find(value => value.categoryIds.some(id => allCategories.get(id)?.domainId === domain.id));
    const byCategory = await api('/api/questions?status=pending&categoryId=' + encodeURIComponent(question.categoryIds[0]));
    assert.ok(byCategory.total > 0);
    const topic = question.tagIds.find(id => allTags.get(id)?.domainId === domain.id);
    assert.ok(topic, 'domain topic missing ' + domain.id);
    assert.ok((await api('/api/questions?status=pending&domainId=' + encodeURIComponent(domain.id) + '&tagIds=' + encodeURIComponent(topic))).total > 0);
    const blocked = await page.request.post(origin + '/api/quick-practice', { data: { questionId: question.id } });
    assert.equal(blocked.status(), 400); assert.equal((await blocked.json()).error.code, 'QUESTION_UNAVAILABLE');
    domainCounts.push({ id: domain.id, name: domain.name, total: result.total, sampleId: question.id });
  }
  checks.push('4新领域与原7领域均可按领域/分类/主题标签筛选，11个领域的待审核样题均被作答API拒绝');
  const pending = originals.find(question => question.id.startsWith('ENGLISH-GRAMMAR-'));
  assert.ok(pending);
  await go('questions/' + encodeURIComponent(pending.id));
  assert.equal(await page.getByRole('button', { name: '开始单题自测', exact: true }).count(), 0);
  await page.getByText('待审核，尚未进入正式题库或组卷。', { exact: true }).waitFor();
  await capture('pending-question-desktop');
  const approval = page.waitForResponse(response => new URL(response.url()).pathname === '/api/questions/review' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认审核通过', exact: true }).click();
  assert.equal((await approval).status(), 200);
  await page.getByRole('button', { name: '开始单题自测', exact: true }).waitFor();
  const remaining = originals.filter(question => question.id !== pending.id);
  for (let start = 0; start < remaining.length; start += 300) {
    const questions = remaining.slice(start, start + 300);
    const result = await api('/api/questions/review', 'POST', { ids: questions.map(question => question.id), action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries(questions.map(question => [question.id, question.updatedAt])) });
    assert.equal(result.count, questions.length);
  }
  assert.equal((await api('/api/questions?status=pending')).total, 0);
  assert.equal((await api('/api/questions')).total, 781);
  checks.push('待审核详情无自测入口；通过实际确认审核按钮及批量审核API，仅批准memory fixture中的781题');
  await go('questions');
  const domainSelect = page.getByLabel('知识领域', { exact: true });
  assert.equal(await domainSelect.locator('option').count(), 12);
  for (const domain of domainCounts) {
    await domainSelect.selectOption(domain.id);
    await page.getByText('找到 ' + domain.total + ' 道题目', { exact: true }).waitFor();
    assert.equal(await domainSelect.inputValue(), domain.id);
  }
  checks.push('题库页面领域下拉展示全部11领域，逐项切换后题量与各包内容一致');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const domain of domainCounts) {
    const sampleId = domain.id === 'physics' ? 'PHY26-TERM-first-law' : domain.sampleId;
    await go('questions/' + encodeURIComponent(sampleId));
    await page.getByRole('button', { name: '我想过了，展开答案与解析', exact: true }).click();
    await page.locator('.answer-content').waitFor();
    assert.ok((await page.locator('.answer-content').innerText()).length > 50, 'empty explanation ' + domain.id);
    if (domain.id === 'physics') {
      assert.match(await page.locator('.answer-content').innerText(), /ΔE=Q−W/);
      assert.match(await page.locator('.answer-content').innerText(), /整体动能/);
    }
    await noOverflow('390px-explanation-' + domain.id);
    if (['japanese', 'physics', 'geography'].includes(domain.id)) await capture('mobile-' + domain.id + '-explanation');
  }
  checks.push('390px逐域打开真实解析均可读，热力学ΔE与ΔU及适用条件完整显示，11领域详情无横向溢出');
  const exerciseQuestions = [
    originals.find(question => question.id.startsWith('ENGLISH-GRAMMAR-') && question.type === 'single_choice'),
    originals.find(question => question.id.startsWith('JAPANESE-GRAMMAR-') && question.type === 'multiple_choice'),
    originals.find(question => question.id.startsWith('GEO26-') && question.type === 'true_false'),
    originals.find(question => question.id.startsWith('PHY26-') && question.type === 'fill_blank'),
    originals.find(question => question.id.startsWith('JAPANESE-GRAMMAR-') && question.type === 'fill_blank'),
  ];
  for (const question of exerciseQuestions) {
    assert.ok(question);
    await go('questions/' + encodeURIComponent(question.id));
    await page.getByRole('button', { name: '开始单题自测', exact: true }).click();
    await page.waitForURL(/#\/attempts\//);
    await page.locator('.exam-question').first().waitFor();
    const attemptId = decodeURIComponent(page.url().split('/').pop());
    const active = await api('/api/attempts/' + attemptId);
    assert.equal(active.questions[0].answerMarkdown, undefined);
    assert.equal(active.questions[0].explanationMarkdown, undefined);
    assert.equal(active.questions[0].correctAnswers, undefined);
    if (question.type === 'fill_blank') {
      const inputs = page.locator('.blank-answer-fields input');
      assert.equal(await inputs.count(), question.blanks.length);
      for (let index = 0; index < question.blanks.length; index++) await inputs.nth(index).fill(question.blanks[index].answers[0]);
    } else {
      const inputs = page.locator('.answer-options input');
      const keys = question.type === 'true_false' ? ['true', 'false'] : question.options.map(option => option.key);
      for (const key of question.correctAnswers) await inputs.nth(keys.indexOf(key)).check();
    }
    await noOverflow('390px-answering-' + question.type);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/attempts/' + attemptId + '/submit' && value.request().method() === 'POST');
    await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().click();
    assert.equal((await response).status(), 200);
    await page.getByText('回答正确', { exact: false }).first().waitFor();
    const submitted = await api('/api/attempts/' + attemptId);
    assert.equal(submitted.answerStates[question.id], 'correct');
    assert.ok(submitted.questions[0].explanationMarkdown.length > 10);
    const details = page.locator('.attempt-answer').first();
    if (!await details.getAttribute('open')) await details.locator(':scope > summary').click();
    assert.ok((await details.innerText()).length > 30);
    await noOverflow('390px-submitted-' + question.type);
    practiced.push({ id: question.id, type: question.type, attemptId, answerState: submitted.answerStates[question.id] });
  }
  await capture('mobile-submitted-japanese-fill');
  checks.push('390px实际完成英语语法单选、日语语法多选/填空、地理判断和物理填空；提交判定全部正确且可展开原解析');
  await go('questions'); await capture('mobile-questions-library');
  assert.deepEqual(browserErrors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, packs: packIds, total: originals.length, domainCounts, practiced, measurements, browserErrors, externalRequests, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ url: page?.url(), checks, stderr }); throw error;
} finally { await browser?.close(); server.kill(); }
