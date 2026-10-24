/** Answering context hides prior learning hints; readers own note editing. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/practice-context-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-practice-context-ui-seed',staticRoot:'dist/web',logger:false});
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,response.body);return response.json();};
const q=(id,type='short_answer',extra={})=>({id,title:id,type,stemMarkdown:'独立题干 '+id,answerMarkdown:'REFERENCE_ANSWER_CANARY_'+id,explanationMarkdown:'REFERENCE_EXPLANATION_CANARY_'+id,status:'published',...extra});
await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[q('CONTEXT-Q'),q('CONTEXT-T','true_false',{correctAnswers:['true']}),q('CONTEXT-G','group',{stemMarkdown:'始终显示的公共阅读材料',parts:[{id:'a',title:'阅读判断小题',type:'true_false',stemMarkdown:'根据材料判断',correctAnswers:['true'],answerMarkdown:'REFERENCE_ANSWER_CANARY_GROUP_A'},{id:'b',title:'阅读问答小题',type:'short_answer',stemMarkdown:'结合材料说明原因',answerMarkdown:'REFERENCE_ANSWER_CANARY_GROUP_B'}]})]}});
const paper=await api('/api/papers','POST',{title:'无提示整卷验收',mode:'manual',questionIds:['CONTEXT-Q','CONTEXT-T'],scoring:{enabled:false}});
const groupPaper=await api('/api/papers','POST',{title:'无提示组合题验收',mode:'manual',questionIds:['CONTEXT-G'],scoring:{enabled:false}});
const old=await api('/api/quick-practice','POST',{questionId:'CONTEXT-Q'});await api('/api/attempts/'+old.id+'/submit','POST',{answers:{'CONTEXT-Q':{value:'HISTORICAL_ANSWER_CANARY'}}});
await api('/api/study/CONTEXT-Q','PUT',{notes:'SAVED_NOTE_CANARY_SINGLE',mastery:3});
await api('/api/study/CONTEXT-G','PUT',{notes:'SAVED_NOTE_CANARY_GROUP',mastery:2});
await api('/api/study/CONTEXT-G','PUT',{partId:'a',notes:'SAVED_NOTE_CANARY_LEAF_A',mastery:1});
await api('/api/study/CONTEXT-G','PUT',{partId:'b',notes:'SAVED_NOTE_CANARY_LEAF_B',mastery:3});
const normal=await api('/api/papers/'+paper.id+'/attempts','POST');
const group=await api('/api/papers/'+groupPaper.id+'/attempts','POST');
const quick=await api('/api/quick-practice','POST',{questionId:'CONTEXT-Q'});
const quickGroup=await api('/api/quick-practice','POST',{questionId:'CONTEXT-G'});
const origin=await app.listen({host:'127.0.0.1',port:0});
console.log('PRACTICE_CONTEXT_READY '+JSON.stringify({origin,paperId:paper.id,groupPaperId:groupPaper.id,normalId:normal.id,groupId:group.id,quickId:quick.id,quickGroupId:quickGroup.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-12000));
const checks = [], errors = [], externalRequests = [], questionRequests = [];
try {
  let state;
  for (let index = 0; index < 300; index++) {
    if (server.exitCode !== null) throw Error('Fixture failed: ' + stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('PRACTICE_CONTEXT_READY '));
    if (line) { state = JSON.parse(line.slice('PRACTICE_CONTEXT_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr); const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  page.on('request', request => { if (/^\/api\/(questions\/[^/]+(?:\/(?:history|statistics))?|study(?:\/.*)?|reviews)$/.test(new URL(request.url()).pathname)) questionRequests.push(request.url()); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data) => { const response = await page.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) }); assert.ok(response.ok(), path + ': ' + await response.text()); return response.json(); };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'document overflow');
  let navigation = 0;
  const navigate = async path => { await page.goto(origin + '/?context-qa=' + ++navigation + '#/' + path); await page.locator('.page-header').waitFor(); await page.waitForLoadState('networkidle'); };
  const assertNoHints = async (id, requestCount) => {
    assert.equal(await page.getByLabel('我的学习笔记', { exact: true }).count(), 0);
    assert.equal(await page.locator('.quick-study-tools, .group-study-tools, .question-history, .question-study-statistics').count(), 0);
    const text = await page.locator('body').innerText();
    for (const hint of ['SAVED_NOTE_CANARY_', 'HISTORICAL_ANSWER_CANARY', 'REFERENCE_ANSWER_CANARY_', 'REFERENCE_EXPLANATION_CANARY_']) assert.ok(!text.includes(hint), 'answering leaked ' + hint);
    assert.equal(questionRequests.length, requestCount, 'answering fetched historical learning content');
    const attempt = await api('/api/attempts/' + id);
    assert.ok(!JSON.stringify(attempt).includes('SAVED_NOTE_CANARY_'));
    for (const question of attempt.questions) { assert.equal(question.study, undefined); assert.equal(question.partStudies, undefined); }
  };
  const submit = async () => { const response = page.waitForResponse(r => /\/api\/attempts\/[^/]+\/submit$/.test(new URL(r.url()).pathname)); await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().click(); assert.equal((await response).status(), 200); await page.locator('.answer-state-text').first().waitFor(); assert.equal(await page.getByLabel('我的学习笔记', { exact: true }).count(), 0); };

  for (const [id, label] of [[state.normalId, '整卷普通练习'], [state.groupId, '整卷组合题'], [state.quickId, '单题自测'], [state.quickGroupId, '组合题自测']]) {
    const before = questionRequests.length; await navigate('attempts/' + id); await assertNoHints(id, before);
    const input = page.locator('.exam-question textarea').first(); await input.fill('本次独立完成的回答');
    const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/attempts/' + id && r.request().method() === 'PUT');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click(); assert.equal((await saved).status(), 200); await assertNoHints(id, before);
    if (id === state.quickGroupId) { await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await page.screenshot({ path: resolve(output, 'group-answering-mobile.png'), fullPage: true }); }
    await submit(); checks.push(label + '不展示旧笔记、历史回答或参考提示，不请求原题学习内容，交卷后无内嵌笔记编辑器');
  }

  await page.getByRole('link', { name: '查看原题与学习笔记', exact: true }).nth(1).click();
  const groupNotes = page.locator('.group-study-tools').getByLabel('我的学习笔记', { exact: true }); await groupNotes.waitFor(); assert.equal(await groupNotes.inputValue(), 'SAVED_NOTE_CANARY_LEAF_B');
  await groupNotes.fill('READING_CONTEXT_NOTE_EDIT');
  const noteSaved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/study/CONTEXT-G' && r.request().method() === 'PUT');
  await page.locator('.group-study-tools').getByRole('button', { name: '保存笔记', exact: true }).click(); assert.equal((await noteSaved).status(), 200);
  const groupCurrent = await api('/api/questions/CONTEXT-G'); assert.equal(groupCurrent.partStudies.find(item => item.partId === 'b').notes, 'READING_CONTEXT_NOTE_EDIT'); assert.equal(groupCurrent.partStudies.find(item => item.partId === 'a').notes, 'SAVED_NOTE_CANARY_LEAF_A');
  checks.push('交卷后从原题入口查看并编辑对应小题笔记，邻题笔记不变');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const exam = await api('/api/papers/' + state.paperId + '/attempts', 'POST', { mode: 'exam', durationMinutes: 5 });
  const beforeExam = questionRequests.length; await navigate('attempts/' + exam.id); await assertNoHints(exam.id, beforeExam); await page.screenshot({ path: resolve(output, 'exam-answering-desktop.png'), fullPage: true }); await submit();
  checks.push('限时考试不含旧学习提示或笔记编辑器，仍可正常提前交卷');

  await navigate('papers');
  const recommendation = page.getByRole('link', { name: 'AI 推荐题集', exact: true }); await recommendation.waitFor(); assert.match(await recommendation.getAttribute('class'), /\bbutton\b/);
  const dimensions = await recommendation.evaluate(node => ({ height: node.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(node).fontSize) })); assert.ok(dimensions.height >= 44 && dimensions.fontSize >= 13, JSON.stringify(dimensions));
  await recommendation.click(); await page.getByRole('heading', { name: /先理解/ }).waitFor();
  await navigate('papers'); await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await recommendation.waitFor(); await page.screenshot({ path: resolve(output, 'prominent-entry-mobile.png'), fullPage: true });
  checks.push('AI推荐题集为显眼可点击按钮，桌面与390px可见、触控高度至少44px且导航有效');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, browserErrors: errors, externalRequests, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error({ url: page?.url(), checks, stderr }); throw error; }
finally { await browser?.close(); server.kill(); }
