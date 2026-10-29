/** Frontend loading regression: Vite source + intercepted local fixtures, no database or AI calls. */
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { tsImport } from 'tsx/esm/api';
import { createViteQaPreparation } from './helpers/vite-preparation.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = resolve(import.meta.dirname, '../..'), folder = resolve(root, 'test-results/web-loading');
const checks = [], pageErrors = [], requests = [], unexpected = [], networkErrors = [], pendingModules = new Set();
const { DEFAULT_SETTINGS } = await tsImport('../../shared/models/settings.ts', import.meta.url);
await mkdir(folder, { recursive: true });
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useResource} from '/web/shared/lib/api.ts';
import {Markdown} from '/web/shared/ui/components.tsx';
const originalFetch=window.fetch.bind(window);
window.qaResourceRequests=[];
window.fetch=(url, options)=>String(url).startsWith('/qa-resource/')?new Promise(resolve=>{
  window.qaResourceRequests.push({url:String(url),signal:options.signal,resolve:value=>resolve(new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}}))});
}):originalFetch(url,options);
function Harness(){
 const [url,setUrl]=useState('/qa-resource/first'),[tick,setTick]=useState(0),[text,setText]=useState('## Stable heading\\n\\nUnchanged **Markdown**.');
 const resource=useResource(url);
 window.qaResource={setUrl,refresh:resource.refresh,resolve:(index,value)=>window.qaResourceRequests[index].resolve(value)};
 return React.createElement('main',null,
 React.createElement('output',{id:'resource-data'},JSON.stringify({data:resource.data,loading:resource.loading,error:resource.error})),
 React.createElement('button',{onClick:()=>setTick(value=>value+1)},'Tick '+tick),
 React.createElement('button',{onClick:()=>setText('## Updated heading')},'Change Markdown'),React.createElement(Markdown,null,text));
}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Harness)));
`;
const fixturePreparationStarted = performance.now();
const preparation = await createViteQaPreparation({ root, cacheDir: resolve(folder, 'vite-cache'), extraUrls: ['/qa-loading-harness.tsx'] });
const vite = await createServer({
  root, configFile: resolve(root, 'vite.config.ts'), ...preparation.config,
  server: { host: '127.0.0.1', port: 0, strictPort: false, open: false },
  plugins: [{
    name: 'qa-web-loading-fixture',
    resolveId(id) { if (id === '/qa-loading-harness.tsx') return '\0qa-loading-harness.tsx'; },
    load(id) { if (id === '\0qa-loading-harness.tsx') return harness; },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url !== '/qa-loading.html') return next();
        try {
          const html = await server.transformIndexHtml('/qa-loading.html', '<!doctype html><html><body><div id="root"></div><script type="module" src="/qa-loading-harness.tsx"></script></body></html>');
          response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html);
        } catch (error) { next(error); }
      });
    },
  }],
});
let browser;
try {
  await preparation.ready(vite);
  const fixturePreparationMs = Math.round(performance.now() - fixturePreparationStarted);
  console.log('WEB_LOADING_PREPARATION ' + JSON.stringify({ fixturePreparationMs, ...preparation.diagnostics }));
  const origin = vite.resolvedUrls.local[0].replace(/\/$/, '');
  console.log('WEB_LOADING_FIXTURE ' + origin);
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(60_000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => pendingModules.add(request.url()));
  page.on('requestfinished', request => pendingModules.delete(request.url()));
  page.on('requestfailed', request => pendingModules.delete(request.url()));
  page.on('requestfailed', request => networkErrors.push({ url: request.url(), failure: request.failure() }));
  page.on('console', message => { if (message.type() === 'error') networkErrors.push({ console: message.text() }); });
  const stamp = new Date().toISOString(); let favorite = false;
  const question = {
    id: 'QA-LOADING', title: '加载回归测试题目', type: 'short_answer', stemMarkdown: '## 概念\n\n解释异步请求与取消。',
    answerMarkdown: '请求结果只更新当前视图。', explanationMarkdown: '旧结果应被忽略。', options: [], correctAnswers: [],
    difficulty: 1, depth: 1, frequency: 3, frequencyScope: '通用学习', frequencyBasis: '隔离测试', collection: 'general',
    status: 'published', categoryIds: ['qa-category'], tagIds: ['qa-tag'], sourceRefs: [], sourceDocument: null,
    sourceAnchor: null, createdAt: stamp, updatedAt: stamp,
  };
  const bootstrap = () => ({
    settings: { ...structuredClone(DEFAULT_SETTINGS), updatedAt: favorite ? new Date(Date.parse(stamp) + 1).toISOString() : stamp, reviewScheduling: { ...DEFAULT_SETTINGS.reviewScheduling, strategy: 'fixed' } },
    domains: [{ id: 'qa-domain', name: '通用学习', description: '', sortOrder: 0 }],
    categories: [{ id: 'qa-category', name: '基础知识', domainId: 'qa-domain', parentId: null, description: '', sortOrder: 0 }],
    tags: [{ id: 'qa-tag', name: '概念题', domainId: null, kind: 'method', description: '', color: '#3c7661' }],
    stats: { totalQuestions: 1, generalQuestions: 1, personalQuestions: 0, totalPapers: 0, totalDocuments: 0, favoriteCount: Number(favorite), dueCount: 0, wrongCount: 0, typeCounts: { short_answer: 1 } },
    ai: { available: true, message: '隔离测试，不执行 AI 请求。' },
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), entry = { path: url.pathname, query: url.search, method: request.method(), started: performance.now(), finished: null };
    requests.push(entry); let data, latency = 0;
    if (url.pathname === '/api/bootstrap') { data = bootstrap(); latency = 300; }
    else if (url.pathname === '/api/exams/sync') { data = { attempt: null }; latency = 350; }
    else if (url.pathname === '/api/daily-push') data = { config: DEFAULT_SETTINGS.dailyPush, today: null, recent: [], recentLimit: 30, unreadCount: 0, nextDateKey: '2026-10-27' };
    else if (url.pathname === '/api/question-feedback/summaries') data = { summaries: Object.fromEntries((request.postDataJSON()?.questionIds || []).map(id => [id, { openCount: 0, pendingCount: 0, confirmedCount: 0, partIds: [], wholeCount: 0, partCounts: {} }])) };
    else if (url.pathname === '/api/questions') data = { items: [{ ...question, study: { questionId: question.id, favorite, mastery: null, notes: '', wrongCount: 0 } }], total: 1, page: 1, pageSize: 20 };
    else if (url.pathname === '/api/questions/' + question.id) data = { ...question, study: { questionId: question.id, favorite, mastery: null, notes: '', wrongCount: 0 } };
    else if (url.pathname === '/api/questions/' + question.id + '/statistics') data = { answered: 0, correct: 0, partial: 0, incorrect: 0, ungraded: 0, lastAnsweredAt: null };
    else if (url.pathname === '/api/ai/runs') data = [];
    else if (url.pathname === '/api/paper-drafts') data = [];
    else if (url.pathname === '/api/study/' + question.id && request.method() === 'PUT') {
      favorite = request.postDataJSON().favorite; data = { questionId: question.id, favorite, mastery: null, notes: '', wrongCount: 0 };
    } else {
      unexpected.push(entry); data = { error: { message: '未声明的隔离测试请求', code: 'QA_UNEXPECTED' } };
    }
    if (latency) await delay(latency); entry.finished = performance.now();
    await route.fulfill({ status: unexpected.includes(entry) ? 500 : 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(origin + '/#/questions', { waitUntil: 'commit', timeout: 30_000 });
  await page.getByRole('link', { name: question.title, exact: true }).waitFor();
  const firstBootstrap = requests.find(item => item.path === '/api/bootstrap'), firstExam = requests.find(item => item.path === '/api/exams/sync');
  assert.ok(firstBootstrap && firstExam);
  assert.ok(firstExam.started < firstBootstrap.finished, '考试校验应与 bootstrap 重叠');
  assert.ok(firstBootstrap.started < firstExam.finished, 'bootstrap 应与考试校验重叠');
  assert.equal(requests.filter(item => item.path === '/api/bootstrap').length, 1);
  assert.equal(requests.filter(item => item.path === '/api/exams/sync').length, 1);
  checks.push('首次 bootstrap 与考试状态并行，StrictMode 仅发送各一次请求');
  await page.waitForLoadState('networkidle');
  assert.equal(requests.filter(item => item.path === '/api/daily-push').length, 1);
  checks.push('StrictMode每日推荐只初始化一次，不产生重复初始查询');
  assert.equal(requests.filter(item => item.path === '/api/question-feedback/summaries').length, 1);
  const firstList = requests.find(item => item.path === '/api/questions');
  assert.ok(firstList.started >= firstExam.finished, '考试校验通过前不可加载受保护页面');
  checks.push('页面请求仍等待考试校验通过，保持考试锁边界');
  assert.equal(requests.filter(item => item.path === '/api/question-banks').length, 0);
  await page.getByRole('button', { name: /^筛选/ }).click();
  await page.getByRole('option', { name: '所有题型', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.getByRole('link', { name: '题库集合', exact: true }).count(), 0);
  assert.equal(requests.filter(item => item.path === '/api/question-banks').length, 0);
  checks.push('筛选可展开，不再查询或显示独立题库集合');
  await page.getByRole('link', { name: question.title, exact: true }).click();
  await page.locator('section.ai-tools').waitFor();
  assert.equal(await page.locator('.ai-request-note').count(), 0);
  assert.equal(requests.filter(item => item.path === '/api/bootstrap').length, 1);
  assert.equal(requests.filter(item => item.path === '/api/ai/settings').length, 0);
  await page.waitForLoadState('networkidle');
  assert.equal(requests.filter(item => item.path === '/api/question-feedback/summaries').length, 2);
  checks.push('StrictMode题目反馈摘要在题库与详情各只发一次，切换仍更新当前题目摘要');
  checks.push('路由切换不重取 bootstrap，已开启AI复用公共状态并隐藏配置提示');
  await page.getByRole('button', { name: '收藏', exact: true }).click();
  await page.getByRole('button', { name: '已收藏', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('学习记录已保存'));
  for (let index = 0; index < 100 && requests.filter(item => item.path === '/api/bootstrap').length < 2; index++) await delay(20);
  assert.equal(requests.filter(item => item.path === '/api/bootstrap').length, 2);
  checks.push('修改学习记录仍主动刷新 bootstrap，无跨页长期缓存');
  for (let index = 0; index < 150 && requests.filter(item => item.path === '/api/daily-push').length < 2; index++) await delay(20);
  assert.equal(requests.filter(item => item.path === '/api/daily-push').length, 2);
  checks.push('配置版本更新仍立即刷新每日推荐，不被初始请求去重吞掉');
  await page.evaluate(() => { window.location.hash = '#/papers/new/manual'; });
  await page.getByRole('button', { name: question.title, exact: true }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '保存组题草稿')?.disabled);
  assert.equal(requests.filter(item => item.path === '/api/paper-drafts').length, 1);
  assert.equal(requests.filter(item => item.path === '/api/question-banks').length, 0);
  checks.push('手动组题草稿在StrictMode只初始化一次，不查询已移除的集合接口');
  const authoringUrl = page.url();
  await page.getByRole('button', { name: question.title, exact: true }).click();
  await page.locator('.question-inline-preview').waitFor();
  assert.equal(page.url(), authoringUrl);
  checks.push('手动候选题仍原地展开，不跳转、不重取已在候选页的题目');

  await page.goto(origin + '/qa-loading.html', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.qaResourceRequests?.length === 1);
  await page.evaluate(() => window.qaResource.setUrl('/qa-resource/second'));
  await page.waitForFunction(() => window.qaResourceRequests.length === 2);
  assert.ok(await page.evaluate(() => window.qaResourceRequests[0].signal.aborted));
  await page.evaluate(() => window.qaResource.resolve(0, { value: 'stale-first' }));
  await delay(50);
  assert.ok(!(await page.locator('#resource-data').innerText()).includes('stale-first'));
  await page.evaluate(() => window.qaResource.resolve(1, { value: 'fresh-second' }));
  await page.waitForFunction(() => document.getElementById('resource-data').textContent.includes('fresh-second'));
  checks.push('切换URL取消旧请求，忽略底层未遵守AbortSignal的旧响应');
  await page.evaluate(() => window.qaResource.setUrl('/qa-resource/third'));
  await page.waitForFunction(() => window.qaResourceRequests.length === 3);
  await page.evaluate(() => window.qaResource.setUrl(null));
  await page.waitForFunction(() => JSON.parse(document.getElementById('resource-data').textContent).loading === false);
  await page.evaluate(() => window.qaResource.resolve(2, { value: 'stale-third' }));
  await delay(50);
  assert.deepEqual(JSON.parse(await page.locator('#resource-data').innerText()), { data: null, loading: false, error: '' });
  checks.push('资源停用后取消请求，迟到结果不会恢复已停用内容');
  await page.evaluate(() => window.qaResource.setUrl('/qa-resource/fourth'));
  await page.waitForFunction(() => window.qaResourceRequests.length === 4);
  await page.evaluate(() => window.qaResource.resolve(3, { value: 'before-refresh' }));
  await page.waitForFunction(() => document.getElementById('resource-data').textContent.includes('before-refresh'));
  await page.evaluate(() => window.qaResource.refresh());
  await page.waitForFunction(() => window.qaResourceRequests.length === 5);
  await page.evaluate(() => window.qaResource.resolve(4, { value: 'after-refresh' }));
  await page.waitForFunction(() => document.getElementById('resource-data').textContent.includes('after-refresh'));
  checks.push('显式refresh立即发新请求并展示新结果');
  await page.evaluate(() => window.qaHeading = document.querySelector('.markdown h2'));
  await page.getByRole('button', { name: 'Tick 0', exact: true }).click();
  await page.getByRole('button', { name: 'Tick 1', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => window.qaHeading === document.querySelector('.markdown h2')));
  await page.getByRole('button', { name: 'Change Markdown', exact: true }).click();
  await page.getByRole('heading', { name: 'Updated heading', exact: true }).waitFor();
  checks.push('计时/输入等父级更新保持正文DOM，Markdown内容变化仍正常重解析');
  assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
  preparation.assertStable(vite);
  checks.push('全部请求使用隔离本地fixture，无真实数据库、AI调用或页面异常');
  const report = { passed: checks.length, checks, requests, pageErrors, database: 'none', server: 'Vite source fixture', fixturePreparationMs, preparation: preparation.diagnostics };
  await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(resolve(folder, 'failure.json'), { force: true });
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  await writeFile(resolve(folder, 'failure.json'), JSON.stringify({ error: String(error.stack || error), checks, requests, unexpected, pageErrors, networkErrors, pendingModules: [...pendingModules], preparation: preparation.diagnostics }, null, 2) + '\n'); throw error;
} finally { await browser?.close(); await vite.close(); }
