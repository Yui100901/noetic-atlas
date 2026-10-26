/** Exercise FSRS against synthetic records in an isolated in-memory service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/adaptive-review-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {DEFAULT_SETTINGS} from './shared/models/settings.ts';
import {questionSchema} from './server/core/validation.ts';
import {buildPaper} from './server/modules/practice/service.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
const staging=new Store(':memory:'),stamp=new Date().toISOString();
staging.put('domains','adaptive-domain',{id:'adaptive-domain',name:'自适应隔离领域',description:'',sortOrder:0});
staging.put('categories','adaptive-category',{id:'adaptive-category',domainId:'adaptive-domain',parentId:null,name:'基础',description:'',sortOrder:0});
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),updatedAt:stamp});
const records=[
 {id:'ADAPT-TF',title:'事务回忆判断',type:'true_false',stemMarkdown:'事务提交后应具有持久性。',correctAnswers:['true']},
 {id:'ADAPT-SA',title:'事务回忆说明',type:'short_answer',stemMarkdown:'解释隔离性。',answerMarkdown:'说明并发隔离和可见性'},
 {id:'ADAPT-GROUP',title:'程序阅读组合',type:'group',stemMarkdown:'两个工作线程读写共享状态。',parts:[
  {id:'tf',title:'并发判断小题',type:'true_false',stemMarkdown:'不加锁是否一定安全？',correctAnswers:['false']},
  {id:'sa',title:'并发说明小题',type:'short_answer',stemMarkdown:'给出同步策略。',answerMarkdown:'说明互斥与数据竞争'},
 ]},
 {id:'ADAPT-WORD',title:'atlas',type:'short_answer',stemMarkdown:'atlas',answerMarkdown:'atlas：地图集。例句含atlas。',vocabulary:{language:'en',headword:'atlas',meaningPrompt:'收录多幅地理地图的书册；地图集。',acceptedAnswers:['atlas'],pronunciations:[{label:'隔离测试',ipa:'/ˈætləs/',sourceLabel:'测试数据',sourceUrl:'https://example.test/ipa',license:'fixture',method:'manual'}]}},
];
for(const record of records)staging.put('questions',record.id,questionSchema.parse({...record,status:'published',categoryIds:['adaptive-category'],createdAt:stamp,updatedAt:stamp}));
staging.putStudy({questionId:'ADAPT-TF',favorite:false,mastery:null,notes:'PRIVATE_TEST_NOTE_CANARY',lastReviewedAt:null,nextReviewAt:null,wrongCount:0});
staging.putStudy({questionId:'ADAPT-WORD',favorite:false,mastery:2,notes:'PRIVATE_WORD_NOTE_CANARY atlas',lastReviewedAt:null,nextReviewAt:null,wrongCount:0});
const paper=buildPaper(staging,{id:'ADAPT-PAPER',title:'自适应复习隔离题集',description:'',mode:'manual',questionIds:['ADAPT-TF','ADAPT-SA','ADAPT-GROUP'],scoring:{enabled:true,totalPoints:12,questionPoints:{'ADAPT-TF':2,'ADAPT-SA':4,'ADAPT-GROUP':6}}});staging.put('papers',paper.id,paper);
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-adaptive-ui-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('ADAPTIVE_READY '+JSON.stringify({origin,paperId:paper.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-18000));
const checks = [], errors = [], externalRequests = [];
try {
  let state;
  for (let index = 0; index < 600; index++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('ADAPTIVE_READY '));
    if (line) { state = JSON.parse(line.slice('ADAPTIVE_READY '.length)); break; } await delay(100);
  }
  assert.ok(state, stderr); const { origin, paperId } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, expected = 200) => {
    const response = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    const text = await response.text(); assert.equal(response.status(), expected, path + ': ' + text); return text ? JSON.parse(text) : null;
  };
  const card = (questionId = 'ADAPT-TF', extra = {}) => api('/api/review-scheduler/card?' + new URLSearchParams({ questionId, ...extra }));
  let navigation = 0;
  const go = async path => { await page.goto(origin + '/?adaptive-ui=' + ++navigation + '#/' + path); await page.waitForLoadState('networkidle'); };
  const waitFor = async predicate => { for (let index = 0; index < 100; index++) { if (await predicate()) return; await delay(100); } throw new Error('Condition timed out'); };
  const capture = async name => {
    await page.evaluate(async () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
  };
  const panel = () => page.getByLabel('自适应复习', { exact: true });
  const rateButton = (target, rating) => target.getByRole('button', { name: new RegExp('^' + rating + ' 下次') });

  await go('questions/ADAPT-TF'); await panel().getByText('尚未建立回忆记录', { exact: true }).waitFor();
  assert.equal(await panel().getByRole('button', { name: /下次/ }).count(), 4); assert.equal((await card()).eventCount, 0);
  await page.locator('.mastery-buttons>button').nth(2).click(); await waitFor(async () => (await api('/api/questions/ADAPT-TF')).study.mastery === 2);
  assert.equal((await card()).eventCount, 0, 'understanding mastery is independent of recall rating');
  const requestIds = []; let firstResponseLost = true;
  const loseResponse = async route => { requestIds.push(JSON.parse(route.request().postData()).requestId); if (firstResponseLost) { firstResponseLost = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); };
  await page.route(origin + '/api/review-scheduler/review', loseResponse);
  await rateButton(panel(), '良好').click(); await panel().getByRole('alert').waitFor(); assert.equal((await card()).eventCount, 1);
  await rateButton(panel(), '良好').click(); await waitFor(async () => (await panel().innerText()).includes('1 次'));
  await page.unroute(origin + '/api/review-scheduler/review', loseResponse);
  assert.equal(requestIds.length, 2); assert.equal(requestIds[0], requestIds[1]); assert.equal((await card()).eventCount, 1);
  assert.equal((await api('/api/questions/ADAPT-TF')).study.mastery, 2);
  await capture('card-desktop'); checks.push('四档预览不造记录，掌握自评独立；手动评级响应丢失后使用同requestId重试且只计一次');

  const attempt = await api('/api/papers/' + paperId + '/attempts', 'POST', {}, 201);
  await go('attempts/' + attempt.id); assert.equal(await page.getByText(/FSRS已记录/).count(), 0); assert.equal(await page.getByLabel('本次回忆评级', { exact: true }).count(), 0); assert.ok(!(await page.locator('body').innerText()).includes('PRIVATE_TEST_NOTE_CANARY'));
  const answers = { 'ADAPT-TF': { value: ['true'] }, 'ADAPT-SA': { value: '提到并发但未完整说明' }, 'ADAPT-GROUP::tf': { value: ['true'] }, 'ADAPT-GROUP::sa': { value: '使用同步' } };
  await api('/api/attempts/' + attempt.id + '/submit', 'POST', { answers });
  await go('attempts/' + attempt.id); await page.getByText(/FSRS已记录 2 项回忆/).waitFor();
  let overview = await api('/api/review-scheduler/attempts/' + attempt.id);
  assert.equal(overview.items.find(item => item.leafId === 'ADAPT-TF').rating, 'good'); assert.equal(overview.items.find(item => item.leafId === 'ADAPT-GROUP::tf').rating, 'again'); assert.equal(overview.items.find(item => item.leafId === 'ADAPT-SA').eligible, false);
  const firstQuestion = page.locator('#exam-1'); await firstQuestion.locator('.attempt-review-scheduling>summary').click(); const contextual = firstQuestion.getByLabel('本次回忆评级', { exact: true });
  await rateButton(contextual, '轻松').click(); await waitFor(async () => (await api('/api/review-scheduler/attempts/' + attempt.id)).items.find(item => item.leafId === 'ADAPT-TF').rating === 'easy');
  const afterOverride = (await card()).eventCount;
  await contextual.getByRole('button', { name: '恢复本次自动评级', exact: true }).click(); await waitFor(async () => (await api('/api/review-scheduler/attempts/' + attempt.id)).items.find(item => item.leafId === 'ADAPT-TF').rating === 'good'); assert.equal((await card()).eventCount, afterOverride);
  await page.locator('#exam-2 .attempt-review-scheduling>summary').click(); assert.equal(await page.locator('#exam-2').getByRole('button', { name: /下次/ }).count(), 0);
  await api('/api/attempts/' + attempt.id + '/review', 'PUT', { scores: { 'ADAPT-SA': 2 } });
  await go('attempts/' + attempt.id); overview = await api('/api/review-scheduler/attempts/' + attempt.id); assert.equal(overview.items.find(item => item.leafId === 'ADAPT-SA').rating, 'again');
  await page.locator('#exam-2 .attempt-review-scheduling>summary').click(); await page.locator('#exam-2').getByLabel('本次回忆评级', { exact: true }).waitFor();
  assert.equal(await rateButton(page.locator('#exam-2').getByLabel('本次回忆评级', { exact: true }), '困难').isDisabled(), true); assert.equal(await rateButton(page.locator('#exam-2').getByLabel('本次回忆评级', { exact: true }), '重学').isEnabled(), true); await capture('attempt-desktop');
  checks.push('作答期间没有记忆提示，交卷后客观题自动良好/重学，未判不记录；原事件覆盖和撤销不重复计次，主观部分正确保守重学');

  const noScorePaper = await api('/api/papers', 'POST', { title: '离线无分主观判定', mode: 'manual', questionIds: ['ADAPT-SA'], scoring: { enabled: false } }, 201);
  const noScoreAttempt = await api('/api/papers/' + noScorePaper.id + '/attempts', 'POST', {}, 201);
  await api('/api/attempts/' + noScoreAttempt.id + '/submit', 'POST', { answers: { 'ADAPT-SA': { value: '独立说明并发隔离与可见性。' } } });
  await go('attempts/' + noScoreAttempt.id);
  const judgment = page.getByRole('group', { name: 'ADAPT-SA 主观题判定', exact: true });
  await judgment.getByRole('button', { name: '正确', exact: true }).click(); await page.getByRole('button', { name: '保存主观判定与自评', exact: true }).click();
  await waitFor(async () => (await api('/api/review-scheduler/attempts/' + noScoreAttempt.id)).items[0].rating === 'good');
  const subjectiveCount = (await card('ADAPT-SA')).eventCount;
  await judgment.getByRole('button', { name: '部分正确', exact: true }).click(); await page.getByRole('button', { name: '保存主观判定与自评', exact: true }).click();
  await waitFor(async () => (await api('/api/review-scheduler/attempts/' + noScoreAttempt.id)).items[0].rating === 'again'); assert.equal((await card('ADAPT-SA')).eventCount, subjectiveCount);
  await judgment.getByRole('button', { name: '未判', exact: true }).click(); await page.getByRole('button', { name: '保存主观判定与自评', exact: true }).click();
  await waitFor(async () => !(await api('/api/review-scheduler/attempts/' + noScoreAttempt.id)).items[0].eventId); assert.equal((await card('ADAPT-SA')).eventCount, subjectiveCount - 1);
  const noScoreResult = await api('/api/attempts/' + noScoreAttempt.id); assert.equal(noScoreResult.scoring.enabled, false); assert.equal(noScoreResult.totalScore, null);
  checks.push('无分主观题可离线人工判正确/部分正确并进入Good/Again；更正不重复，撤销未判移除原事件且始终不生成分数');

  await go('questions/ADAPT-GROUP'); await page.getByLabel('选择小题学习记录', { exact: true }).selectOption('sa');
  await rateButton(panel(), '困难').click(); await waitFor(async () => (await card('ADAPT-GROUP', { partId: 'sa' })).latestRating === 'hard');
  const groupTfCount = (await card('ADAPT-GROUP', { partId: 'tf' })).eventCount;
  assert.equal((await card('ADAPT-GROUP', { partId: 'sa' })).eventCount, 1); assert.equal((await card('ADAPT-GROUP', { partId: 'tf' })).eventCount, groupTfCount);
  await api('/api/review-scheduler/review', 'POST', { questionId: 'ADAPT-WORD', direction: 'word_to_meaning', rating: 'good', requestId: 'vocab-forward-ui' });
  await api('/api/review-scheduler/review', 'POST', { questionId: 'ADAPT-WORD', direction: 'meaning_to_word', rating: 'again', requestId: 'vocab-reverse-ui' });
  await api('/api/review-scheduler/card', 'PATCH', { questionId: 'ADAPT-WORD', direction: 'meaning_to_word', dueAt: new Date(Date.now() - 3600000).toISOString() });
  await go('learning/due'); await page.getByLabel('任务方向', { exact: true }).selectOption('meaning_to_word');
  await page.getByRole('button', { name: '复习任务：看释义想词', exact: true }).click();
  const wordDialog = page.getByRole('dialog', { name: '逆向复习：看释义想词', exact: true }); await wordDialog.getByText('收录多幅地理地图的书册；地图集。', { exact: true }).waitFor();
  assert.ok(!(await wordDialog.innerText()).includes('atlas')); assert.ok(!(await wordDialog.innerText()).includes('PRIVATE_WORD_NOTE_CANARY'));
  await wordDialog.getByRole('button', { name: '展开答案与解析', exact: true }).click(); await wordDialog.getByText('目标词语：', { exact: true }).waitFor(); assert.ok((await wordDialog.innerText()).includes('atlas'));
  await rateButton(wordDialog.getByLabel('自适应复习', { exact: true }), '良好').click(); await waitFor(async () => (await card('ADAPT-WORD', { direction: 'meaning_to_word' })).eventCount === 2);
  assert.equal((await card('ADAPT-WORD', { direction: 'word_to_meaning' })).eventCount, 1);
  await wordDialog.getByRole('button', { name: '关闭', exact: true }).click(); checks.push('组合小题独立评级，词汇顺逆向独立；实时队列原地复习保留筛选，逆向展开答案前隐藏词头、读音、笔记和历史');

  await go('questions/ADAPT-TF'); await panel().getByText('暂停或调整复习日期', { exact: true }).click();
  const earlier = new Date(Date.now() - 86400000).toISOString().slice(0, 16);
  await panel().getByLabel('下次复习时间', { exact: true }).fill(earlier); await panel().getByRole('button', { name: '保存复习时间', exact: true }).click(); await waitFor(async () => Date.parse((await card()).dueAt) < Date.now());
  await go('questions/ADAPT-TF'); await panel().getByText('暂停或调整复习日期', { exact: true }).click();
  const countBeforePause = (await card()).eventCount;
  await panel().getByRole('button', { name: '暂停复习', exact: true }).click(); await waitFor(async () => (await card()).suspended);
  await go('learning/due'); await page.getByLabel('自适应复习队列', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '复习任务：事务回忆判断', exact: true }).count(), 0);
  await go('questions/ADAPT-TF'); await panel().getByText('暂停或调整复习日期', { exact: true }).click(); await panel().getByRole('button', { name: '恢复复习', exact: true }).click(); await waitFor(async () => !(await card()).suspended); assert.equal((await card()).eventCount, countBeforePause);
  await go('learning/due'); await page.getByRole('button', { name: '复习任务：事务回忆判断', exact: true }).waitFor();
  assert.equal(await page.locator('.global-learning-questions').count(), 0, 'adaptive queue replaces the old duplicate due listing');
  checks.push('手动改期和暂停/恢复不增加回忆次数，到期队列实时更新并替代重复旧列表');

  await go('settings'); await page.getByLabel('复习调度方式', { exact: true }).selectOption('fixed'); await page.getByRole('button', { name: '保存系统配置', exact: true }).click(); await waitFor(async () => (await api('/api/settings')).reviewScheduling.strategy === 'fixed');
  await go('questions/ADAPT-TF'); assert.equal(await panel().count(), 0); await page.getByText('调整复习日期', { exact: true }).waitFor();
  await go('settings'); await page.getByLabel('复习调度方式', { exact: true }).selectOption('fsrs'); await page.getByLabel('目标记忆率（%）', { exact: true }).fill('90'); await page.getByRole('button', { name: '保存系统配置', exact: true }).click(); await waitFor(async () => (await api('/api/settings')).reviewScheduling.strategy === 'fsrs');
  checks.push('系统配置可保存FSRS参数并切换固定间隔；两种策略的界面与独立掌握记录保持明确');

  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } }); await page.setViewportSize({ width: 390, height: 844 });
  await go('questions/ADAPT-TF'); await rateButton(panel(), '良好').waitFor(); await capture('card-dark-mobile');
  await go('learning/due'); await page.getByLabel('自适应复习队列', { exact: true }).waitFor(); await capture('queue-dark-mobile');
  await go('settings'); await page.getByLabel('复习调度方式', { exact: true }).waitFor(); await capture('settings-dark-mobile');
  checks.push('390px暗色题目、实时队列和设置无横向溢出，四档按钮和配置控件可用');

  const exam = await api('/api/papers/' + paperId + '/attempts', 'POST', { mode: 'exam', durationMinutes: 120 }, 201);
  await go('attempts/' + exam.id); await page.getByLabel('考试倒计时', { exact: true }).waitFor(); assert.equal(await page.getByText(/FSRS已记录/).count(), 0); assert.equal(await page.locator('.review-rating-buttons').count(), 0);
  assert.equal((await api('/api/review-scheduler/card?questionId=ADAPT-TF', 'GET', undefined, 409)).error.code, 'EXAM_ACTIVE');
  await api('/api/attempts/' + exam.id + '/submit', 'POST', { answers: {} });
  checks.push('考试期间不暴露复习状态，调度API受统一考试锁，空白交卷不作为遗忘');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, errors, externalRequests, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await rm(resolve(output, 'failure.png'), { force: true }); console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error({ url: page?.url(), checks, stderr }); throw error; }
finally { await browser?.close(); server.kill(); }
