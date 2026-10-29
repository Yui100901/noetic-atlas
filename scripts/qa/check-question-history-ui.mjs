/** Question-history acceptance: disposable in-memory service and loopback model. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'test-results/question-history-ui');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {buildApp} from './server/index.ts';
const modelRequests=[];
const model=createServer(async(request,response)=>{
  try {
    const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const content=body.messages[1].content;
    const input=JSON.parse(typeof content==='string'?content:content[0].text),material=input.untrustedMaterial;
    const result={items:material.items.map(item=>({questionId:item.questionId,verdict:item.questionId.endsWith('-C')?'correct':item.questionId.endsWith('-P')?'partial':'incorrect',score:null,maxPoints:null,comment:'隔离模型评价：'+item.questionId,strengths:['保留实际作答内容'],improvements:['对照参考答案核对要点']}))};
    modelRequests.push({gradingRequirements:material.gradingRequirements,questionIds:material.items.map(item=>item.questionId),maxPoints:material.items.map(item=>item.maxPoints)});
    response.writeHead(200,{'Content-Type':'application/json',Connection:'close'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  } catch(error) {response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:String(error)}));}
});
await new Promise(done=>model.listen(0,'127.0.0.1',done));
const app=await buildApp({databasePath:':memory:',seedPath:'no-question-history-ui-seed',staticRoot:'dist/web',logger:false});
app.get('/qa/question-history',async()=>({modelRequests}));
const api=async(url,method='GET',payload)=>{const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<400,r.body);return r.json();};
const q=(id,type='short_answer',extra={})=>({id,title:id,type,stemMarkdown:'原始题干 '+id,answerMarkdown:'原始参考答案 '+id,explanationMarkdown:'原始解析 '+id,status:'published',...(type==='true_false'?{correctAnswers:['true']}:{}),...extra});
await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[
  q('H-COUNT','true_false'),q('H-OMIT'),q('H-LONG'),q('H-FROZEN'),
  q('H-GROUP','group',{title:'组合小题历史验收',stemMarkdown:'原始公共材料：整组共享，但各小题独立作答。',parts:[{id:'a',title:'甲题',type:'true_false',stemMarkdown:'甲题独立判断',correctAnswers:['true'],answerMarkdown:'甲题参考答案'},{id:'b',title:'乙题',type:'short_answer',stemMarkdown:'乙题独立说明',answerMarkdown:'乙题参考答案'}]}),
  q('H-AI-C'),q('H-AI-P'),q('H-AI-I')
]}});
const paper=async(title,questionIds)=>api('/api/papers','POST',{title,mode:'manual',questionIds,scoring:{enabled:false}});
const submit=async(saved,answers)=>{const draft=await api('/api/papers/'+saved.id+'/attempts','POST');return api('/api/attempts/'+draft.id+'/submit','POST',{answers});};
const quick=async(id,value)=>{const draft=await api('/api/quick-practice','POST',{questionId:id});return api('/api/attempts/'+draft.id+'/submit','POST',{answers:{[id]:{value}}});};
const a=await paper('跨题集来源甲',['H-COUNT','H-OMIT']),b=await paper('跨题集来源乙',['H-COUNT','H-OMIT']);
await submit(a,{'H-COUNT':{value:'true'},'H-OMIT':{value:'  \\n\\t '}});
await submit(b,{'H-COUNT':{value:'false'}});await quick('H-COUNT','true');
const draft=await api('/api/papers/'+a.id+'/attempts','POST');await api('/api/attempts/'+draft.id,'PUT',{answers:{'H-COUNT':{value:'true'}}});
const longAttempts=[];for(let i=0;i<12;i++)longAttempts.push(await quick('H-LONG','完整的第'+i+'次回答，保留换行\\n以及独立思考。'));
const frozenPaper=await paper('快照与清理验收题集',['H-FROZEN']);
const frozenOld=await submit(frozenPaper,{'H-FROZEN':{value:'独立保留的旧回答\\n第二行仍然完整。'}});
const frozenRecent=await submit(frozenPaper,{'H-FROZEN':{value:'当前较新的完整回答'}});
const current=await api('/api/questions/H-FROZEN');await api('/api/questions/H-FROZEN','PUT',{...current,study:undefined,stemMarkdown:'原题后来编辑的题干',answerMarkdown:'原题后来编辑的答案'});
const groupPaper=await paper('组合小题独立验收卷',['H-GROUP']);
await submit(groupPaper,{'H-GROUP::a':{value:'true'},'H-GROUP::b':{value:'乙题只提交这一份完整回答'}});
await submit(groupPaper,{'H-GROUP::a':{value:'false'},'H-GROUP::b':{value:'  '}});
const aiPaper=await paper('无分三态AI同页验收',['H-AI-C','H-AI-P','H-AI-I']);
const aiAttempt=await submit(aiPaper,Object.fromEntries(['H-AI-C','H-AI-P','H-AI-I'].map(id=>[id,{value:'我的实际回答 '+id}])));
await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'question-history-loopback',supportsImages:false,sendImages:false,timeoutSeconds:30,maxTokens:4096});
const origin=await app.listen({host:'127.0.0.1',port:0});
console.log('QUESTION_HISTORY_READY '+JSON.stringify({origin,longIds:longAttempts.map(item=>item.id),frozenOldId:frozenOld.id,frozenRecentId:frozenRecent.id,groupPaperId:groupPaper.id,aiAttemptId:aiAttempt.id}));
`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', chunk => stdout += chunk); server.stderr.on('data', chunk => stderr = (stderr + chunk).slice(-15000));
const checks = [], errors = [], externalRequests = [], historyRequests = [];
await mkdir(output, { recursive: true });
try {
  let state;
  for (let index = 0; index < 300; index++) {
    if (server.exitCode !== null) throw Error('Disposable fixture failed: ' + stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('QUESTION_HISTORY_READY '));
    if (line) { state = JSON.parse(line.slice('QUESTION_HISTORY_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr);
  const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  page.on('request', request => { if (/\/api\/questions\/[^/]+\/history$/.test(new URL(request.url()).pathname)) historyRequests.push(request.url()); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    externalRequests.push(url.origin); return route.abort();
  });
  const api = async (path, method = 'GET', data) => { const response = await page.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) }); assert.ok(response.ok(), path + ': ' + await response.text()); return response.json(); };
  let navigation = 0;
  const navigate = async path => { await page.goto(origin + '/?history-qa=' + ++navigation + '#/' + path); await page.locator('.page-header').waitFor(); };
  const open = async (panel = page.locator('.question-history').first()) => { await panel.locator('.question-history-toggle').click(); await panel.locator('.question-history-retention').waitFor(); assert.equal(await panel.locator('.question-history-stats').count(), 0, 'detail history must not duplicate sidebar counters'); return panel; };
  const stats = async panel => {
    const questionId = await panel.getAttribute('data-question-id'), partId = await panel.getAttribute('data-part-id');
    const sidebar = page.locator(`.question-study-statistics[data-question-id="${questionId}"][data-part-id="${partId}"]`);
    await sidebar.locator('.question-history-stats').waitFor();
    return sidebar.locator('.question-history-stats > div').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.querySelector('dt').textContent, Number(node.querySelector('dd').textContent.replace(/[^0-9]/g, ''))])));
  };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390px document overflow');
  const configure = async (changes, expectPruning = true) => {
    await navigate('settings');
    await page.locator('.settings-retention > summary').click();
    for (const [label, value] of Object.entries(changes)) await page.getByLabel(label, { exact: true }).fill(String(value));
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存系统配置', exact: true }).click(); const response = await saved;
    if (response.status() === 409) {
      const dialog = page.getByRole('dialog', { name: '确认记录保留范围', exact: true }); await dialog.waitFor();
      if (Object.hasOwn(changes, '每题最多完整作答历史')) assert.match(await dialog.innerText(), /\d+份单题详细记录/);
      const confirmed = page.waitForResponse(value => new URL(value.url()).pathname === '/api/settings' && value.request().method() === 'PUT');
      await dialog.getByRole('button', { name: '确认保存并清理记录', exact: true }).click(); assert.equal((await confirmed).status(), 200); await dialog.waitFor({ state: 'hidden' });
    } else { assert.equal(response.status(), 200); assert.equal(expectPruning, false, 'expected a concrete pruning confirmation'); }
    return api('/api/settings');
  };

  const defaults = await api('/api/settings'); assert.equal(defaults.maxQuestionHistory, 10); assert.equal(defaults.maxHistoryPerPaper, 0); assert.equal(defaults.maxQuickHistory, 0);
  await navigate('questions/H-COUNT'); await page.locator('.question-history-toggle').waitFor();
  assert.equal(historyRequests.length, 0); let panel = await open();
  assert.deepEqual(await stats(panel), { 实际作答: 3, 正确: 2, 错误: 1, 部分正确: 0, 未判: 0 });
  assert.equal(await panel.locator('.question-history-record').count(), 3);
  const sources = await panel.locator('.question-history-record-info').allTextContents();
  for (const text of ['跨题集来源甲', '跨题集来源乙', '随机 / 单题自测']) assert.ok(sources.some(source => source.includes(text)));
  await navigate('questions/H-OMIT'); panel = await open(); assert.equal((await stats(panel)).实际作答, 0); assert.equal(await panel.locator('.question-history-record').count(), 0);
  checks.push('统计独立展示在学习情况，主列历史默认折叠不请求；同题跨题集合计，草稿、漏答和空白回答不计次数');

  await navigate('questions/H-LONG'); panel = await open(); assert.equal((await stats(panel)).实际作答, 12); assert.equal(await panel.locator('.question-history-record').count(), 10); assert.match(await panel.innerText(), /最近 10 次/);
  const oldest = await api('/api/attempts/' + state.longIds[0]); assert.match(oldest.answers['H-LONG'].value, /第0次回答/);
  await panel.locator('.question-history-record > summary').first().click(); await panel.getByRole('link', { name: '打开整卷复盘 →', exact: true }).waitFor();
  const positions = await page.evaluate(() => { const history = document.querySelector('.detail-main > .question-history').getBoundingClientRect(), statistics = document.querySelector('.detail-aside .question-study-statistics').getBoundingClientRect(); return { historyRight: history.right, statisticsLeft: statistics.left }; });
  assert.ok(positions.statisticsLeft >= positions.historyRight, JSON.stringify(positions));
  await page.locator('.detail-aside').getByText('学习情况', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(output, 'default-ten-desktop.png'), fullPage: true });
  checks.push('单题默认只保留最近10份完整作答，累计12次；最早整卷仍可读取并提供整卷复盘入口');

  await navigate('questions/H-GROUP'); panel = await open(page.locator('.detail-main > .question-history')); assert.equal((await stats(panel)).实际作答, 3);
  const tools = page.locator('.group-study-tools'); let partPanel = await open(tools.locator('.question-history'));
  assert.deepEqual(await stats(partPanel), { 实际作答: 2, 正确: 1, 错误: 1, 部分正确: 0, 未判: 0 });
  await tools.getByLabel('选择小题学习记录', { exact: true }).selectOption('b'); partPanel = await open(tools.locator('.question-history')); assert.equal((await stats(partPanel)).实际作答, 1); assert.equal((await stats(partPanel)).未判, 1);
  await partPanel.locator('.question-history-record > summary').click(); await partPanel.getByText('乙题只提交这一份完整回答', { exact: true }).waitFor(); await partPanel.getByText('原始公共材料：整组共享，但各小题独立作答。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); assert.ok(await partPanel.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: resolve(output, 'group-history-mobile.png'), fullPage: true });
  await navigate('papers/' + state.groupPaperId); await page.getByLabel('查看题目：甲题', { exact: true }).click();
  const viewer = page.locator('main'); partPanel = await open(viewer.locator('.question-history')); assert.equal((await stats(partPanel)).实际作答, 2);
  await noOverflow(); assert.ok(await viewer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)); await page.screenshot({ path: resolve(output, 'snapshot-part-history-mobile.png'), fullPage: true });
  await viewer.locator('.question-viewer-aside').scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'snapshot-learning-situation-mobile.png'), animations: 'disabled' });
  await viewer.getByRole('link', { name: /^返回题集(?:\s|$)/ }).click();
  checks.push('组合题分别统计小题与整组合计，材料和完整答案保留；题集快照共用单题历史，390px无横向溢出');

  await page.setViewportSize({ width: 1440, height: 1000 }); await configure({ 每题集最多已提交整卷历史: 1 });
  const oldResponse = await page.request.get(origin + '/api/attempts/' + state.frozenOldId); assert.equal(oldResponse.status(), 404);
  await navigate('questions/H-FROZEN'); panel = await open(); assert.equal((await stats(panel)).实际作答, 2);
  const archived = panel.locator('.question-history-record').filter({ hasText: '快照与清理验收题集' }).last(); await archived.locator('summary').click();
  for (const text of ['原始题干 H-FROZEN', '原始参考答案 H-FROZEN', '原始解析 H-FROZEN']) await archived.getByText(text, { exact: true }).waitFor();
  assert.equal(await archived.locator('.question-history-answer-text').innerText(), '独立保留的旧回答\n第二行仍然完整。');
  assert.equal(await archived.getByRole('link', { name: '打开整卷复盘 →', exact: true }).count(), 0); await archived.getByText('整卷历史已清理，本题完整作答仍保留。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await page.screenshot({ path: resolve(output, 'archived-full-answer-mobile.png'), fullPage: true });
  checks.push('清理整卷并编辑原题后，保留范围内的单题仍展示旧题干、参考答案、解析、换行作答及来源，并标明整卷已清理');

  await page.setViewportSize({ width: 1440, height: 1000 }); await configure({ 每题最多完整作答历史: 2 });
  await navigate('questions/H-LONG'); panel = await open(); assert.equal((await stats(panel)).实际作答, 12); assert.equal(await panel.locator('.question-history-record').count(), 2); assert.match(await panel.innerText(), /最近 2 次/);
  await api('/api/attempts/' + state.longIds[0]); await configure({ 每题最多完整作答历史: 10 }, false);
  assert.equal((await api('/api/questions/H-LONG/history')).total, 2);
  checks.push('配置通过页面具体预览确认清理单题详细记录，累计统计和整卷保留；调高上限不会重新出现已清理条目');

  await navigate('attempts/' + state.aiAttemptId);
  assert.equal(await page.locator('.answer-state-text.status-ungraded').count(), 3);
  await page.getByRole('button', { name: 'AI评价主观题', exact: true }).click();
  const aiDialog = page.getByRole('dialog', { name: 'AI评价多道主观题', exact: true });
  const requirements = '必须说明整体提交与失败回滚；只答出部分要点时判部分正确。'; await aiDialog.getByLabel('本次判题要求（可选）', { exact: true }).fill(requirements);
  await aiDialog.getByRole('button', { name: '生成 3 题的建议评价', exact: true }).click(); await aiDialog.locator('.ai-grade-card').nth(2).waitFor();
  for (const verdict of ['正确', '部分正确', '错误']) await aiDialog.getByText(verdict, { exact: true }).waitFor();
  assert.equal(await page.locator('.answer-state-text.status-ungraded').count(), 3);
  const before = await api('/api/attempts/' + state.aiAttemptId); assert.equal(before.totalScore, null);
  await aiDialog.getByRole('button', { name: '确认应用选中判题结果', exact: true }).click(); await aiDialog.getByText('已应用判题结果', { exact: true }).nth(2).waitFor();
  await aiDialog.getByRole('button', { name: '关闭', exact: true }).click();
  for (const stateName of ['correct', 'partial', 'incorrect']) await page.locator('.answer-state-text.status-' + stateName).waitFor();
  const ai = await api('/api/attempts/' + state.aiAttemptId); assert.equal(ai.totalScore, null); for (const answer of Object.values(ai.answers)) assert.equal(answer.selfScore, undefined);
  const provider = await api('/qa/question-history'); assert.equal(provider.modelRequests.length, 1); assert.equal(provider.modelRequests[0].gradingRequirements, requirements); assert.deepEqual(provider.modelRequests[0].maxPoints, [null, null, null]);
  await page.screenshot({ path: resolve(output, 'ai-three-verdicts-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await page.screenshot({ path: resolve(output, 'ai-three-verdicts-mobile.png'), fullPage: true });
  for (const [id, label] of [['H-AI-C', '正确'], ['H-AI-P', '部分正确'], ['H-AI-I', '错误']]) { await navigate('questions/' + id); panel = await open(); assert.equal((await stats(panel))[label], 1); assert.equal((await stats(panel)).实际作答, 1); }
  checks.push('同一无分练习通过本地AI生成并确认三态判定；要求传到模型，应用前未判，应用后同页正确/部分正确/错误且不生成分数，单题统计各计1次');

  await configure({ 每题最多完整作答历史: 0 }); await navigate('questions/H-LONG'); panel = await open();
  assert.equal((await stats(panel)).实际作答, 12); assert.equal(await panel.locator('.question-history-record').count(), 0); assert.match(await panel.innerText(), /已关闭单题详细历史/); await api('/api/attempts/' + state.longIds[0]);
  checks.push('配置0关闭单题详细历史，累计作答12次和完整整卷继续保留');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, browserErrors: errors, externalRequests, isolated: true, databasePath: ':memory:', model: 'loopback-only' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ url: page?.url(), checks, stderr }); throw error;
} finally { await browser?.close(); server.kill(); }
