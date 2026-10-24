/** Combination-question study acceptance on a disposable in-memory service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const code = `import {buildApp} from './server/index.ts';
import {createServer} from 'node:http';
const model=createServer(async(request,response)=>{for await(const _chunk of request){}response.writeHead(200,{'Content-Type':'application/json',Connection:'close'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({explanationMarkdown:'隔离模型生成的小题解析',followUpsMarkdown:'',pitfallsMarkdown:''})}}]}));});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const app=await buildApp({databasePath:':memory:',seedPath:'no-study-parts-qa',staticRoot:'dist/web'});
const call=async(method,url,payload)=>{const r=await app.inject({method,url,...(payload===undefined?{}:{payload})});if(r.statusCode>=400)throw Error(r.body);return r.json();};
const settings=await call('GET','/api/ai/settings');const {hasKey,...configuration}=settings;await call('PUT','/api/ai/settings',{...configuration,enabled:true,baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'local-study-parts-fixture'});
const parts=['first','second'].map((id,index)=>({id,title:index?'第二小题':'第一小题',type:'true_false',stemMarkdown:index?'第二小题单独理解':'第一小题单独理解',options:[],correctAnswers:['true'],answerMarkdown:index?'第二小题参考答案':'第一小题参考答案',explanationMarkdown:''}));
await call('POST','/api/import',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[{id:'GROUP-QA',title:'小题学习验收材料',type:'group',stemMarkdown:'一直保留的公共材料：同一情景，两道独立小题。',parts,status:'published'}]}});
const paper=await call('POST','/api/papers',{title:'小题学习验收题集',mode:'manual',questionIds:['GROUP-QA'],scoring:{enabled:false}});
await call('PUT','/api/study/GROUP-QA',{notes:'旧整组笔记不复制到小题'});
await call('POST','/api/study/GROUP-QA/review',{mastery:2});
const quick=await call('POST','/api/quick-practice',{questionId:'GROUP-QA'});
await app.listen({host:'127.0.0.1',port:0});console.log('STUDY_PARTS_READY '+JSON.stringify({origin:'http://127.0.0.1:'+app.server.address().port,paperId:paper.id,quickId:quick.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr += value);
const output = 'test-results/study-parts-ui'; await mkdir(output, { recursive: true });
const checks = [], errors = [], confirmations = [];
try {
  let state;
  for (let i = 0; i < 250; i++) {
    if (server.exitCode !== null) throw Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('STUDY_PARTS_READY '));
    if (line) { state = JSON.parse(line.slice('STUDY_PARTS_READY '.length)); break; }
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(state, stderr); const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => { confirmations.push(dialog.message()); void dialog.accept(); });
  const api = async (path, method = 'GET', data) => { const r = await page.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) }); assert.ok(r.ok(), await r.text()); return r.json(); };
  const current = () => api('/api/questions/GROUP-QA');
  const partState = (question, id) => question.partStudies.find(item => item.partId === id);
  const notes = scope => scope.getByLabel('我的学习笔记', { exact: true });
  const save = async (scope, value) => {
    await notes(scope).fill(value);
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/study/GROUP-QA' && r.request().method() === 'PUT');
    await scope.getByRole('button', { name: '保存笔记', exact: true }).click(); assert.equal((await response).status(), 200);
    await page.waitForFunction(expected => Array.from(document.querySelectorAll('.form-actions .muted')).some(item => item.textContent === '笔记已同步'), value);
  };

  await page.goto(origin + '/#/questions/GROUP-QA');
  const libraryTools = page.locator('.group-study-tools'); await notes(libraryTools).waitFor();
  assert.equal(await notes(libraryTools).inputValue(), '');
  assert.equal(await libraryTools.locator('.mastery-buttons .selected').count(), 0);
  await save(libraryTools, '题库中第一小题的笔记');
  const review = page.waitForResponse(r => r.url().endsWith('/api/study/GROUP-QA/review'));
  await libraryTools.getByRole('button', { name: /3\s*能深入/ }).click(); assert.equal((await review).status(), 200);
  await libraryTools.getByLabel('选择小题学习记录', { exact: true }).selectOption('second');
  await page.waitForFunction(() => document.querySelector('.group-study-tools textarea')?.value === '');
  assert.equal(await libraryTools.locator('.mastery-buttons .selected').count(), 0);
  await save(libraryTools, '题库中第二小题的笔记');
  let q = await current(); assert.equal(partState(q, 'first').mastery, 3); assert.equal(partState(q, 'second').mastery, null); assert.equal(q.study.mastery, 2); assert.equal(q.study.notes, '旧整组笔记不复制到小题');
  checks.push('题库按小题记录掌握与笔记，整组历史不克隆给小题');

  await libraryTools.getByRole('button', { name: '收藏整组', exact: true }).click();
  await libraryTools.getByRole('button', { name: '已收藏', exact: true }).waitFor(); q = await current(); assert.equal(q.study.favorite, true); assert.ok(q.partStudies.every(item => item.favorite === false));
  await libraryTools.getByText('整组历史与公共笔记', { exact: true }).click();
  await libraryTools.getByText('旧整组笔记不复制到小题', { exact: true }).waitFor();
  await libraryTools.getByText('整组掌握：2/3', { exact: false }).waitFor();
  checks.push('收藏属于整组，旧整组笔记和复习历史可独立展开查看');

  await notes(libraryTools).fill('尚未保存的第二小题草稿');
  await libraryTools.getByLabel('选择小题学习记录', { exact: true }).selectOption('first');
  await page.waitForFunction(() => document.querySelector('.group-study-tools textarea')?.value === '题库中第一小题的笔记');
  assert.equal(confirmations.filter(message => message.includes('笔记尚未保存')).length, 1);
  assert.equal(partState(await current(), 'second').notes, '题库中第二小题的笔记');
  checks.push('切换小题提示未保存内容，草稿不会串到相邻小题');

  await notes(libraryTools).fill('AI追加前尚未保存的第一题笔记');
  const ai = page.locator('.ai-tools'); await ai.getByLabel('解释范围', { exact: true }).selectOption('first');
  await ai.getByRole('button', { name: '生成 AI 解析', exact: true }).click();
  await ai.getByText('隔离模型生成的小题解析', { exact: true }).waitFor();
  await ai.getByRole('button', { name: '追加到学习笔记', exact: true }).click();
  await page.waitForFunction(() => { const value = document.querySelector('.group-study-tools textarea')?.value; return value?.startsWith('AI追加前尚未保存的第一题笔记') && value.includes('隔离模型生成的小题解析'); });
  const firstAfterAi = partState(await current(), 'first').notes;
  assert.equal(partState(await current(), 'second').notes, '题库中第二小题的笔记');
  assert.equal((await current()).study.notes, '旧整组笔记不复制到小题');
  checks.push('本地模拟AI追加前先保存小题草稿，追加后刷新笔记且不覆盖相邻小题或整组笔记');

  await page.goto(origin + '/#/papers/' + encodeURIComponent(state.paperId));
  await page.getByRole('button', { name: '查看题目：第一小题', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '题集内看题', exact: true });
  await dialog.getByText('一直保留的公共材料：同一情景，两道独立小题。', { exact: true }).waitFor();
  await page.waitForFunction(expected => document.querySelector('[role="dialog"] textarea')?.value === expected, firstAfterAi);
  await save(dialog, '题集里更新的第一小题笔记');
  await dialog.getByRole('button', { name: '下一题', exact: true }).click();
  await dialog.getByRole('heading', { name: '第二小题', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.value === '题库中第二小题的笔记');
  await dialog.getByText('一直保留的公共材料：同一情景，两道独立小题。', { exact: true }).waitFor();
  const date = '2031-04-12'; await dialog.getByLabel('调整复习日期', { exact: true }).fill(date);
  await dialog.getByRole('button', { name: '更新日期', exact: true }).click();
  await page.waitForFunction(async expected => { const r = await fetch('/api/questions/GROUP-QA'); return (await r.json()).partStudies.find(item => item.partId === 'second').nextReviewAt?.startsWith(expected); }, date);
  q = await current(); assert.equal(partState(q, 'first').notes, '题集里更新的第一小题笔记'); assert.equal(partState(q, 'second').notes, '题库中第二小题的笔记'); assert.ok(!partState(q, 'first').nextReviewAt.startsWith(date));
  checks.push('题集快照始终保留公共材料，前后切换绑定对应小题笔记与复习日期');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: output + '/part-reader-mobile.png', animations: 'disabled' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.goto(origin + '/#/attempts/' + encodeURIComponent(state.quickId));
  const quickTools = page.locator('.group-study-tools'); await notes(quickTools).waitFor();
  await page.waitForFunction(() => document.querySelector('.group-study-tools textarea')?.value === '题集里更新的第一小题笔记');
  await quickTools.getByLabel('选择小题学习记录', { exact: true }).selectOption('second');
  await page.waitForFunction(() => document.querySelector('.group-study-tools textarea')?.value === '题库中第二小题的笔记');
  await save(quickTools, '随机自测中第二小题的笔记');
  q = await current(); assert.equal(partState(q, 'first').notes, '题集里更新的第一小题笔记'); assert.equal(partState(q, 'second').notes, '随机自测中第二小题的笔记'); assert.equal(q.study.notes, '旧整组笔记不复制到小题');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: output + '/quick-parts-mobile.png', animations: 'disabled' });
  checks.push('随机自测使用同一套小题学习控件，390px题集弹窗与自测页均无横向溢出');

  assert.deepEqual(errors, []);
  const report = { passed: checks.length, checks, browserErrors: errors, isolated: true, databasePath: ':memory:' };
  await writeFile(output + '/report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: output + '/failure.png' }).catch(() => {}); console.error({ url: page?.url(), checks, stderr }); throw error; }
finally { await browser?.close(); server.kill(); }
