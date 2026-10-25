/** Unified search is verified against a disposable in-memory service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/search-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {DEFAULT_SETTINGS} from './shared/models/settings.ts';
import {questionSchema,documentSchema} from './server/core/validation.ts';
import {buildPaper,createAttempt,submitAttempt} from './server/modules/practice/service.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
import {PDFDocument} from 'pdf-lib';
const staging=new Store(':memory:'),stamp='2026-10-25T02:00:00.000Z';
staging.put('domains','search-domain',{id:'search-domain',name:'星图检索领域',description:'统一搜索验收',sortOrder:0});
staging.put('categories','search-category',{id:'search-category',domainId:'search-domain',name:'星图检索分类',description:'分类说明',parentId:null,sortOrder:0});
staging.put('tags','search-tag',{id:'search-tag',name:'星图检索标签',description:'检索标签',domainId:'search-domain',kind:'topic',color:'#39C5BB'});
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),updatedAt:stamp});
const titles={
 'SEARCH-TITLE':'星图检索 概念卡', 'SEARCH-BODY':'正文检索判断', 'SEARCH-GROUP':'组合材料',
 'SEARCH-XSS':'星图检索 <img src=x onerror=globalThis.__searchXss=1>',
 'SEARCH-PENDING':'星图检索 待审核', 'SEARCH-DRAFT':'星图检索 草稿题', 'SEARCH-ARCHIVED':'星图检索 已归档',
 'SEARCH-ENGLISH':'Concurrency Essentials', 'SEARCH-LITERAL':"literal%_quote O'Reilly",
};
for(const [id,title] of Object.entries(titles)){
 const type=id==='SEARCH-GROUP'?'group':id==='SEARCH-TITLE'?'short_answer':'true_false';
 const common={id,title,type,stemMarkdown:id==='SEARCH-BODY'?'这是星图检索的正文命题。':id==='SEARCH-XSS'?'星图检索 安全摘要 <script>globalThis.__searchXss=2</script>':'独立知识命题',
  answerMarkdown:'REFERENCE_PRIVATE_CANARY',explanationMarkdown:'EXPLANATION_PRIVATE_CANARY',categoryIds:['search-category'],tagIds:['search-tag'],
  status:id==='SEARCH-PENDING'?'pending':id==='SEARCH-DRAFT'?'draft':id==='SEARCH-ARCHIVED'?'archived':'published',createdAt:stamp,updatedAt:stamp};
 const specifics=type==='group'?{parts:[{id:'first',title:'第一小题',type:'true_false',stemMarkdown:'星图检索 CHILD_ONLY_NEEDLE',correctAnswers:['true']},{id:'second',title:'第二小题',type:'short_answer',stemMarkdown:'解释材料',answerMarkdown:'REFERENCE_PRIVATE_CANARY'}]}:type==='true_false'?{correctAnswers:['true']}:{};
 staging.put('questions',id,questionSchema.parse({...common,...specifics}));
}
for(let index=0;index<25;index++){
 const id='SEARCH-PAGE-'+index.toString().padStart(2,'0');
 staging.put('questions',id,questionSchema.parse({id,title:'分页样本 '+index.toString().padStart(2,'0'),type:'true_false',stemMarkdown:'分页验收命题',correctAnswers:['true'],status:'published',categoryIds:['search-category'],updatedAt:stamp}));
}
const paper=(id,title,description,archived=false)=>{const record=buildPaper(staging,{id,title,description,mode:'manual',organization:'domain',domainId:'search-domain',questionIds:['SEARCH-TITLE','SEARCH-BODY','SEARCH-GROUP']});staging.put('papers',id,{...record,archived});return record;};
const mainPaper=paper('SEARCH-PAPER','星图检索 练习题集','有效题集');paper('SEARCH-PAPER-DESCRIPTION','背景习题集','星图检索 PAPER_BODY_NEEDLE');paper('SEARCH-PAPER-ARCHIVED','星图检索 已归档题集','归档',true);
submitAttempt(staging,createAttempt(staging,mainPaper),{'SEARCH-TITLE':{value:'PRIVATE_STUDENT_CANARY'}});
const pdf=await PDFDocument.create();pdf.addPage([300,400]);pdf.setSubject('PDF_BINARY_ONLY_CANARY');const bytes=await pdf.save();
staging.put('assets','SEARCH-PDF-ASSET',{id:'SEARCH-PDF-ASSET',filename:'SearchAtlas.pdf',mimeType:'application/pdf',dataBase64:Buffer.from(bytes).toString('base64'),sizeBytes:bytes.length,createdAt:stamp});
for(const input of [
 {id:'SEARCH-MD',title:'星图检索 学习资料',kind:'书籍',bodyMarkdown:'# 基础'+String.fromCharCode(10,10)+'MD_BODY_NEEDLE 是资料正文中的唯一关键词。',format:'markdown'},
 {id:'SEARCH-PDF',title:'星图检索 PDF书籍',kind:'书籍',format:'pdf',assetId:'SEARCH-PDF-ASSET',fileName:'SearchAtlas.pdf',author:'PDF_METADATA_AUTHOR',description:'PDF_METADATA_NEEDLE'},
 {id:'SEARCH-DOC-ARCHIVED',title:'星图检索 归档资料',bodyMarkdown:'归档正文',format:'markdown'},
]){const record=documentSchema.parse({...input,categoryIds:['search-category'],domainIds:['search-domain'],tagIds:['search-tag'],updatedAt:stamp});staging.put('documents',record.id,{...record,...(record.id==='SEARCH-DOC-ARCHIVED'?{_archived:true}:{})});}
staging.putStudy({questionId:'SEARCH-TITLE',favorite:false,notes:'星图检索 我的整题笔记 NOTE_ONLY_NEEDLE',mastery:null,nextReviewAt:null,lastReviewedAt:null,wrongCount:0});
staging.putStudy({questionId:'SEARCH-GROUP',partId:'second',favorite:false,notes:'星图检索 小题笔记 PART_NOTE_NEEDLE',mastery:null,nextReviewAt:null,lastReviewedAt:null,wrongCount:0});
staging.putStudy({questionId:'SEARCH-PENDING',favorite:false,notes:'星图检索 待审核题笔记',mastery:null,nextReviewAt:null,lastReviewedAt:null,wrongCount:0});
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-search-ui-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
const ai=await app.inject({url:'/api/ai/settings',method:'PUT',payload:{enabled:false,baseUrl:'https://example.invalid',model:'SEARCH_AI_MODEL_CANARY',key:'SEARCH_AI_KEY_CANARY',supportsImages:false,sendImages:false,timeoutSeconds:30,maxTokens:1024}});assert.equal(ai.statusCode,200,ai.body);
const draft=await app.inject({url:'/api/document-drafts',method:'POST',payload:{documentId:null,baseDocumentUpdatedAt:null,state:{title:'PRIVATE_DRAFT_CANARY',kind:'书籍',format:'markdown',bodyMarkdown:'星图检索 DRAFT_BODY_NEEDLE',domainIds:['search-domain'],categoryIds:['search-category'],tagIds:[],collection:'general'}}});assert.equal(draft.statusCode,201,draft.body);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('SEARCH_READY '+JSON.stringify({origin,mainPaperId:mainPaper.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-18000));
const checks = [], errors = [], externalRequests = [];
try {
  let state;
  for (let index = 0; index < 600; index++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('SEARCH_READY '));
    if (line) { state = JSON.parse(line.slice('SEARCH_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr); const { origin, mainPaperId } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, expected = 200) => {
    const response = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    const text = await response.text(); assert.equal(response.status(), expected, path + ': ' + text); return text ? JSON.parse(text) : null;
  };
  let navigation = 0;
  const go = async path => { await page.goto(origin + '/?search-ui=' + ++navigation + '#/' + path); await page.waitForLoadState('networkidle'); };
  const capture = async name => {
    await page.evaluate(async () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
  };
  const searchApi = (q, rest = {}) => api('/api/search?' + new URLSearchParams({ q, page: '1', pageSize: '100', ...rest }));
  const privateContent = /REFERENCE_PRIVATE_CANARY|EXPLANATION_PRIVATE_CANARY|PRIVATE_STUDENT_CANARY|SEARCH_AI_KEY_CANARY|SEARCH_AI_MODEL_CANARY|PRIVATE_DRAFT_CANARY|PDF_BINARY_ONLY_CANARY/;
  const report = await searchApi('星图检索');
  assert.equal(report.totalAll, 13); assert.equal(report.total, 13);
  assert.deepEqual(report.counts, { question: 4, paper: 2, document: 2, note: 2, domain: 1, category: 1, tag: 1 });
  assert.doesNotMatch(JSON.stringify(report), privateContent);
  const pending = await searchApi('星图检索', { includeUnpublished: 'true' }); assert.equal(pending.totalAll, 16); assert.equal(pending.counts.question, 6); assert.equal(pending.counts.note, 3);
  assert.ok(!pending.items.some(item => /ARCHIVED/.test(item.id)));
  for (const [q, type, id] of [['child_only_needle', 'question', 'SEARCH-GROUP'], ['md_body_needle', 'document', 'SEARCH-MD'], ['PDF_METADATA_NEEDLE', 'document', 'SEARCH-PDF'], ['NOTE_ONLY_NEEDLE', 'note', undefined], ['PART_NOTE_NEEDLE', 'note', undefined], ["literal%_quote O'Reilly", 'question', 'SEARCH-LITERAL'], ['%', 'question', 'SEARCH-LITERAL'], ['concurrency', 'question', 'SEARCH-ENGLISH'], ['ＣＯＮＣＵＲＲＥＮＣＹ', 'question', 'SEARCH-ENGLISH']]) {
    const found = await searchApi(q); assert.equal(found.total, 1, q); assert.equal(found.items[0].type, type); if (id) assert.equal(found.items[0].id, id);
  }
  for (const q of ['PRIVATE_STUDENT_CANARY', 'SEARCH_AI_KEY_CANARY', 'SEARCH_AI_MODEL_CANARY', 'DRAFT_BODY_NEEDLE', 'PDF_BINARY_ONLY_CANARY']) assert.equal((await searchApi(q)).total, 0, q);
  assert.equal((await searchApi('concurrency UNMATCHED_UNIQUE_NEEDLE')).total, 0, 'space-separated terms use AND');
  const reference = await searchApi('REFERENCE_PRIVATE_CANARY'); assert.ok(reference.total > 0); assert.ok(reference.items.every(item => item.matchIn === 'reference')); assert.doesNotMatch(JSON.stringify(reference.items), privateContent);
  const paged = await searchApi('分页样本', { type: 'question', pageSize: '10', page: '2' }); assert.equal(paged.total, 25); assert.equal(paged.items.length, 10); assert.equal(new Set(paged.items.map(item => item.key)).size, 10);
  checks.push('七类搜索覆盖正文、小题、笔记及PDF元数据，未发布/归档边界、字面字符、大小写、分页与私密数据隔离符合约定');

  await go('');
  const top = page.getByLabel('全站搜索', { exact: true });
  await top.fill('星图检索'); await top.press('Enter');
  await page.waitForURL(/#\/search\?/); await page.getByLabel('搜索关键词', { exact: true }).waitFor();
  const resultList = () => page.getByRole('list', { name: '统一搜索结果', exact: true });
  await resultList().waitFor();
  assert.equal(new URLSearchParams(page.url().split('?').at(-1)).get('q'), '星图检索');
  assert.ok(await resultList().locator('mark').count() > 0); assert.equal(await resultList().locator('img,script,iframe').count(), 0); assert.equal(await page.evaluate(() => globalThis.__searchXss || 0), 0);
  await capture('search-desktop');
  checks.push('顶部原搜索Enter进入统一结果页，跨类别结果安全高亮，HTML样式关键词不执行脚本');

  const tab = label => page.getByRole('tablist', { name: '搜索结果类型', exact: true }).getByRole('tab', { name: new RegExp('^' + label) });
  const summary = () => page.getByRole('status', { name: '搜索结果统计', exact: true });
  const form = () => page.getByRole('search', { name: '搜索内容', exact: true });
  const searched = async action => {
    const loading = page.waitForResponse(response => new URL(response.url()).pathname === '/api/search' && response.request().method() === 'GET');
    await action(); const response = await loading; assert.equal(response.status(), 200); await response.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await summary().waitFor();
  };
  const submitQuery = async value => { await page.getByLabel('搜索关键词', { exact: true }).fill(value); await searched(() => form().getByRole('button', { name: '搜索', exact: true }).click()); };
  const queryState = () => new URLSearchParams(page.url().split('#')[1].split('?')[1] || '');
  await searched(() => tab('题目').click()); await resultList().waitFor();
  assert.equal(await resultList().getByRole('listitem').count(), 4); assert.equal(queryState().get('type'), 'question');
  assert.match(await summary().innerText(), /全部类型\s*13\s*条/);
  await searched(() => page.getByLabel('包含未发布题目', { exact: true }).check()); await resultList().locator('.search-status-pending').waitFor();
  assert.equal(await resultList().getByRole('listitem').count(), 6); assert.match(await summary().innerText(), /全部类型\s*16\s*条/);
  assert.equal(queryState().get('includeUnpublished'), 'true');
  await searched(() => page.getByLabel('包含未发布题目', { exact: true }).uncheck()); await resultList().waitFor();
  assert.equal(await resultList().getByText('待审核', { exact: true }).count(), 0);
  checks.push('类型筛选保留全类别计数，未发布开关加入待审核与草稿且不混入归档，筛选状态写入URL');

  await submitQuery('分页样本');
  const pagination = () => page.getByRole('navigation', { name: '搜索结果分页', exact: true });
  await searched(() => page.getByLabel('搜索结果每页数量', { exact: true }).selectOption('10')); await resultList().waitFor();
  assert.equal(await resultList().getByRole('listitem').count(), 10); assert.equal(queryState().get('pageSize'), '10');
  await searched(() => pagination().getByRole('button', { name: /^下一页/ }).click()); await resultList().waitFor();
  assert.equal(queryState().get('page'), '2');
  await searched(() => page.getByLabel('结果排序', { exact: true }).selectOption('updatedAt')); await resultList().waitFor();
  assert.equal(queryState().get('sort'), 'updatedAt'); assert.notEqual(queryState().get('page'), '2');
  await searched(() => pagination().getByRole('button', { name: /^下一页/ }).click()); await resultList().waitFor();
  const beforeOpen = page.url().split('#')[1], selectedTitle = await resultList().locator('h2 a').first().innerText();
  await resultList().locator('h2 a').first().click(); await page.waitForURL(/#\/questions\//);
  const back = page.getByRole('link', { name: '返回搜索结果', exact: true }); await back.waitFor();
  assert.equal(await back.getAttribute('href'), '#' + beforeOpen); assert.ok(page.url().includes('returnTo='));
  await searched(() => page.goBack()); await resultList().waitFor(); assert.equal(page.url().split('#')[1], beforeOpen);
  assert.equal(await resultList().locator('h2 a').first().innerText(), selectedTitle); assert.equal(await page.getByLabel('搜索结果每页数量', { exact: true }).inputValue(), '10');
  await resultList().locator('h2 a').first().click(); await back.waitFor(); await searched(() => back.click()); await resultList().waitFor(); assert.equal(page.url().split('#')[1], beforeOpen);
  checks.push('分页及每页数量、排序保持稳定；打开结果后浏览器返回和返回搜索按钮均恢复原查询筛选页码');

  for (const [type, field, title] of [['domain', 'domainId', '星图检索领域'], ['category', 'categoryId', '星图检索分类'], ['tag', 'tagIds', '星图检索标签']]) {
    await go('search?' + new URLSearchParams({ q: '星图检索', type })); await resultList().waitFor();
    const filteredRequest = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === '/api/questions' && url.searchParams.get(field) === (type === 'domain' ? 'search-domain' : type === 'category' ? 'search-category' : 'search-tag'); });
    await resultList().getByRole('link', { name: title, exact: true }).click(); assert.equal((await filteredRequest).status(), 200);
    assert.ok(page.url().includes(field + '=')); await page.getByRole('link', { name: '返回搜索结果', exact: true }).waitFor();
  }
  await go('search?' + new URLSearchParams({ q: 'PART_NOTE_NEEDLE', type: 'note' })); await resultList().waitFor();
  await resultList().locator('h2 a').first().click(); await page.waitForURL(/#\/questions\/SEARCH-GROUP\?/);
  assert.equal(queryState().get('part'), 'second');
  await page.getByLabel('选择小题学习记录', { exact: true }).waitFor(); assert.equal(await page.getByLabel('选择小题学习记录', { exact: true }).inputValue(), 'second');
  await page.getByLabel('我的学习笔记', { exact: true }).waitFor(); assert.match(await page.getByLabel('我的学习笔记', { exact: true }).inputValue(), /PART_NOTE_NEEDLE/);
  await page.getByRole('link', { name: '返回搜索结果', exact: true }).click(); await resultList().waitFor();
  checks.push('领域/分类/标签结果转入真实筛选，组合小题笔记直达对应小题，仍可回到原搜索');

  await go('search'); await page.getByRole('heading', { name: '从一个关键词开始', exact: true }).waitFor();
  await submitQuery('UNMATCHED_UNIQUE_NEEDLE'); await page.getByRole('heading', { name: '没有找到匹配的内容', exact: true }).waitFor();
  await page.getByLabel('搜索关键词', { exact: true }).fill('一 二 三 四 五 六 七 八 九'); await form().getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '一次最多输入8个关键词' }).waitFor();
  const failedEndpoint = url => url.origin === origin && url.pathname === '/api/search';
  const failSearch = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SEARCH_QA_RETRY', message: '隔离搜索请求暂不可用' } }) });
  await page.route(failedEndpoint, failSearch); await go('search?q=星图检索');
  await page.getByRole('alert').filter({ hasText: '隔离搜索请求暂不可用' }).waitFor();
  await page.unroute(failedEndpoint, failSearch); await page.getByRole('button', { name: '重新加载', exact: true }).click(); await resultList().waitFor();
  await page.getByText('搜索范围与使用说明', { exact: true }).click(); await page.getByText(/PDF目前检索标题、作者、简介/).waitFor();
  checks.push('空搜索、无匹配、过多关键词和请求失败均有明确信息，支持重试并说明PDF元数据范围');

  await go(''); await page.locator('h1').click(); await page.keyboard.press('Control+k'); assert.equal(await top.evaluate(element => element === document.activeElement), true);
  await top.press('Escape'); assert.equal(await top.evaluate(element => element === document.activeElement), false);
  await page.locator('h1').click(); await page.keyboard.press('Meta+k'); assert.equal(await top.evaluate(element => element === document.activeElement), true); await top.press('Escape');
  await go('documents/SEARCH-MD/edit'); const titleInput = page.getByLabel('资料标题 *', { exact: true }); await titleInput.waitFor(); await titleInput.focus(); await titleInput.press('Control+k');
  assert.equal(await titleInput.evaluate(element => element === document.activeElement), true); assert.equal(await top.evaluate(element => element === document.activeElement), false);
  checks.push('Ctrl/Cmd+K从普通页面聚焦原顶栏搜索，Escape退出，编辑资料时不抢占输入焦点');

  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  await page.setViewportSize({ width: 390, height: 844 }); await go('search?q=星图检索'); await resultList().waitFor();
  await capture('search-dark-mobile');
  assert.ok(await top.isVisible()); await top.fill('MD_BODY_NEEDLE'); await top.press('Enter'); await resultList().waitFor();
  await resultList().getByRole('link', { name: '星图检索 学习资料', exact: true }).waitFor(); await capture('search-document-mobile');
  checks.push('390px暗色顶栏可搜索，结果类型和筛选正常换行，安全摘要与资料结果可点击且无横向溢出');

  const exam = await api('/api/papers/' + mainPaperId + '/attempts', 'POST', { mode: 'exam', durationMinutes: 120 }, 201);
  const locked = await api('/api/search?q=星图检索', 'GET', undefined, 409); assert.equal(locked.error.code, 'EXAM_ACTIVE');
  await go('search?q=星图检索'); await page.getByLabel('考试倒计时', { exact: true }).waitFor(); assert.ok(page.url().includes('#/attempts/' + exam.id));
  await page.locator('h1').first().click(); await page.keyboard.press('Control+k'); assert.equal(await top.evaluate(element => element === document.activeElement), false);
  await top.fill('MD_BODY_NEEDLE'); await top.press('Enter'); assert.ok(page.url().includes('#/attempts/' + exam.id));
  await api('/api/attempts/' + exam.id + '/submit', 'POST');
  checks.push('考试期间统一搜索接口、快捷键和提交入口均遵守统一考试锁，不泄露其他页面内容');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  await rm(resolve(output, 'failure.png'), { force: true });
  const result = { passed: checks.length, checks, errors, externalRequests, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ url: page?.url(), checks, stderr }); throw error;
} finally {
  await browser?.close(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}
