import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const folder = resolve('test-results/ai-document-ui'); await mkdir(folder, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/qa/serve-ai-document.ts'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = '', stderr = '', browser;
server.stdout.on('data', chunk => stdout += chunk); server.stderr.on('data', chunk => stderr += chunk);
const checks = [], pageErrors = [], unexpectedNetwork = [];
try {
  for (let tick = 0; tick < 600 && !stdout.includes('AI_DOCUMENT_READY '); tick++) { if (server.exitCode !== null) throw new Error(stderr); await delay(100); }
  const ready = stdout.split(/\r?\n/).find(line => line.startsWith('AI_DOCUMENT_READY ')); assert.ok(ready, stderr + stdout);
  const { origin } = JSON.parse(ready.slice('AI_DOCUMENT_READY '.length));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' }); page.setDefaultTimeout(60_000);
  page.on('pageerror', error => pageErrors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); unexpectedNetwork.push(url.href); return route.abort(); });
  const state = async () => (await (await page.request.get(origin + '/qa/ai-document')).json());
  const job = async id => (await (await page.request.get(origin + '/api/ai/document-jobs/' + id)).json());
  const settle = async (check, label) => { for (let tick = 0; tick < 150; tick++) { if (await check()) return; await delay(100); } throw new Error('Timed out: ' + label); };
  const restoreDraft = async kind => {
    const controls=page.locator(`[data-draft-kind="${kind}"]`);await controls.waitFor();
    await page.waitForFunction(value=>{const section=document.querySelector(`[data-draft-kind="${value}"]`);return section&&(section.querySelector('[role="dialog"]')||Array.from(section.querySelectorAll('button')).some(button=>button.textContent.trim()==='保存草稿'&&!button.disabled));},kind);
    const choices=controls.getByRole('dialog',{name:'继续AI工作台草稿',exact:true});
    if(await choices.isVisible()){await choices.getByRole('button',{name:'继续此草稿',exact:true}).first().click();await choices.waitFor({state:'hidden'});}
    await page.waitForFunction(value=>Array.from(document.querySelector(`[data-draft-kind="${value}"]`)?.querySelectorAll('button')||[]).some(button=>button.textContent.trim()==='保存草稿'&&!button.disabled),kind);
  };
  await page.goto(origin + '/#/ai?tab=documents'); await page.getByLabel('AI分批原始文件', { exact: true }).waitFor({ state: 'attached' });
  let book, bookPages;
  try { book = await readFile('test-results/ai-live-textbook/thinkpython2-source.pdf'); bookPages = (await PDFDocument.load(book)).getPageCount(); }
  catch { const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica); for (let index = 0; index < 151; index++) pdf.addPage([612, 792]).drawText('Variables bind names to values. Page ' + (index + 1), { x: 35, y: 730, size: 12, font }); book = Buffer.from(await pdf.save()); bookPages = 151; }
  await page.getByLabel('AI分批原始文件', { exact: true }).setInputFiles({ name: 'large-textbook.pdf', mimeType: 'application/pdf', buffer: book });
  await page.getByText(new RegExp(`已读取1份资料、${bookPages}页PDF`)).waitFor(); assert.equal((await state()).requests.length, 0); checks.push(`超过150页的${bookPages}页教材在本机分块，未请求模型`);
  await page.getByLabel('PDF起始页（可选）', { exact: true }).fill('31'); await page.getByLabel('PDF结束页（可选）', { exact: true }).fill('35');
  await page.getByLabel('AI分批原始文件', { exact: true }).setInputFiles({ name: 'selected-pages.pdf', mimeType: 'application/pdf', buffer: book });
  await page.getByText(/已读取1份资料、5页PDF/).waitFor(); await page.getByText('核对初始分块和提取正文', { exact: true }).click(); assert.match(await page.locator('.ai-local-sections').innerText(), /第31/); checks.push('PDF页码范围和真实来源页段保留，提取预览按需展开');
  await page.getByLabel('PDF起始页（可选）', { exact: true }).fill(''); await page.getByLabel('PDF结束页（可选）', { exact: true }).fill('');
  await page.getByLabel('AI分批原始文件', { exact: true }).setInputFiles([
    { name: 'variables.md', mimeType: 'text/markdown', buffer: Buffer.from('# Variables\nNames reference values.') },
    { name: 'retry.md', mimeType: 'text/markdown', buffer: Buffer.from('# Transactions\nTransactions commit or roll back. QA_PLAN_RETRY') },
    { name: 'precedence.md', mimeType: 'text/markdown', buffer: Buffer.from('# Precedence\nMultiplication precedes addition. QA_GENERATE_RETRY') },
  ]);
  await page.getByText(/已读取3份资料/).waitFor(); await page.getByLabel('每块最多题量', { exact: true }).fill('2'); await page.getByLabel('整个任务最多题量', { exact: true }).fill('3');
  await page.getByLabel('教材出处链接（可选）', { exact: true }).fill('https://example.invalid/textbook'); await page.getByLabel('分批题目难度', { exact: true }).selectOption('2');
  await page.getByRole('checkbox', { name: '简答 / 场景', exact: true }).check(); await page.getByRole('checkbox', { name: '计算机 / 教材基础', exact: true }).check();
  await page.getByRole('button', { name: '创建可恢复教材任务', exact: true }).click(); await page.getByRole('region', { name: '教材分批任务' }).waitFor();
  const id = (await state()).jobs.items[0].id; assert.equal((await state()).requests.length, 0); assert.equal((await job(id)).blockCount, 3); checks.push('多文件创建持久任务，分类/题型/难度/预算固定，确认前未发模型');
  await page.getByRole('button', { name: 'AI总结选中知识块', exact: true }).click();
  await settle(async () => (await job(id)).plannedBlocks === 2 && (await job(id)).failedBlocks === 1, 'partial summary'); await page.getByRole('button', { name: '重试失败总结', exact: true }).waitFor();
  assert.equal((await state()).questions.total, 0); assert.ok((await state()).runs.items.some(run => run.status === 'failed' && run.failure.code === 'AI_PROVIDER_ERROR')); checks.push('多轮总结保留成功块，429失败原因和历史可见，不新增题目');
  await page.getByRole('button', { name: '重试失败总结', exact: true }).click(); await settle(async () => (await job(id)).plannedBlocks === 3, 'retry summary');
  const summaries = (await state()).requests.filter(item => item.kind === 'plan'); assert.equal(summaries.length, 4); assert.equal(summaries.filter(item => item.sourceName === 'variables.md').length, 1); checks.push('只重试失败总结，成功块不重复调用');
  await page.getByRole('button', { name: /^为选中知识块生成题目/ }).click(); await settle(async () => (await job(id)).questionCount === 2 && (await job(id)).failedBlocks === 1, 'partial generation');
  const failedBlock = (await job(id)).blocks.find(block => block.generationStatus === 'failed'); assert.ok(failedBlock.generationFailure.auditId);
  assert.equal((await state()).questions.total, 0); assert.ok((await state()).requests.filter(item => item.kind === 'generate').every(item => item.count === 1)); checks.push('全选时按3题总预算均摊每块1题，失败批次不影响其余预览');
  await page.locator(`[data-document-block="${failedBlock.id}"]`).getByRole('link', { name: '查看具体失败记录', exact: true }).click();
  await page.getByRole('dialog', { name: 'AI处理失败详情', exact: true }).waitFor(); const failureText = await page.getByRole('dialog').innerText(); assert.match(failureText, /AI_PROVIDER_ERROR/); assert.match(failureText, /503/); assert.doesNotMatch(failureText, /PRIVATE_PROVIDER_BODY_SHOULD_NOT_APPEAR|qa-placeholder/); checks.push('失败历史展示具体HTTP/阶段/建议且不泄露提供商正文或密钥'); await page.screenshot({ path: resolve(folder, 'history-failure.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭', exact: true }).click(); await page.getByLabel('AI记录状态', { exact: true }).selectOption('failed'); await page.locator('.ai-history-item').first().waitFor(); assert.equal(await page.locator('.ai-history-item').count(), 2); checks.push('AI历史支持失败筛选，任务和分块可追溯');
  await page.goto(origin + '/#/ai?tab=documents&job=' + id);await restoreDraft('documents');await restoreDraft('document-job'); await page.getByRole('region', { name: '教材分批任务' }).waitFor(); await page.getByRole('button', { name: /^重试失败出题/ }).click(); await settle(async () => (await job(id)).questionCount === 3 && (await job(id)).failedBlocks === 0, 'retry generation');
  assert.equal((await state()).requests.filter(item => item.kind === 'generate').length, 4); checks.push('重新打开任务继续，仅重试失败出题并沿用每块预算');
  const beforeImport = await job(id), first = beforeImport.blocks[0]; await page.locator(`[data-document-block="${first.id}"]`).getByRole('button', { name: /^展开知识块/ }).click();
  await page.getByText('编辑本块完整题目 JSON', { exact: true }).click(); const editor = page.getByLabel(`知识块 ${first.label} 题目JSON`, { exact: true }); const preview = JSON.parse(await editor.inputValue());
  const grouped = structuredClone(preview); grouped[0].type = 'group'; grouped[0].answerMarkdown = ''; grouped[0].explanationMarkdown = ''; grouped[0].parts = [{ id: 'choice', title: '选择小题预览', type: 'single_choice', stemMarkdown: '选择正确项。', options: [{ key: 'A', text: '第一项预览内容' }, { key: 'B', text: '第二项预览内容' }], correctAnswers: ['A'], answerMarkdown: 'A', explanationMarkdown: '第一项符合条件。' }, { id: 'short', title: '简答小题预览', type: 'short_answer', stemMarkdown: '说明原因。', answerMarkdown: '依据材料解释。', explanationMarkdown: '按材料核对。' }];
  await editor.fill(JSON.stringify(grouped)); await page.locator(`[data-document-block="${first.id}"] .ai-document-question-previews>details>summary`).first().click(); await page.locator('.part-reading-option').filter({hasText:'第一项预览内容'}).first().waitFor(); checks.push('组合题预览按标题展开，显示小题选项与答案，选择复选框独立操作');
  preview[0].title = '用户核对后的变量题'; await editor.fill(JSON.stringify(preview));
  await page.getByRole('button', { name: /^确认选中预览到待审核/ }).click(); await settle(async () => (await state()).questions.total === 3, 'pending import');
  const imported = (await state()).questions.items; assert.ok(imported.every(question => question.status === 'pending')); assert.ok(imported.some(question => question.title === '用户核对后的变量题')); assert.ok(imported.every(question => question.categoryIds.includes('document-python') && question.sourceRefs[0].url === 'https://example.invalid/textbook')); checks.push('编辑预览后显式确认新增3题且统一待审核，来源与分类保留');
  assert.equal(await page.getByRole('button', { name: /^确认选中预览到待审核/ }).isDisabled(), true); checks.push('已导入批次不允许重复确认'); await page.screenshot({ path: resolve(folder, 'document-desktop.png'), fullPage: true });
  // Flush both parent inputs and task edits through their visible controls
  // before refreshing; then explicitly continue each saved context.
  for(const kind of ['documents','document-job']){const controls=page.locator(`[data-draft-kind="${kind}"]`);await controls.getByRole('button',{name:'保存草稿',exact:true}).click();await restoreDraft(kind);}
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();await restoreDraft('documents');await restoreDraft('document-job'); await page.getByRole('region', { name: '教材分批任务' }).waitFor(); await settle(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile width'); await page.screenshot({ path: resolve(folder, 'document-mobile.png'), fullPage: true }); checks.push('390px分批任务及预览无横向溢出，刷新后选择草稿可恢复教材任务和编辑上下文');
  assert.deepEqual(pageErrors, []); assert.deepEqual(unexpectedNetwork, []); checks.push('零浏览器异常和外部请求，全部写入隔离内存库');
  const report = { passed: checks.length, checks, pageErrors, unexpectedNetwork, sourcePages: bookPages, database: ':memory:', provider: 'loopback-only' }; await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await writeFile(resolve(folder, 'failure.json'), JSON.stringify({ error: String(error.stack || error), checks, pageErrors, unexpectedNetwork, stderr }, null, 2)); throw error; }
finally { await browser?.close(); server.kill('SIGTERM'); if (server.exitCode === null) await Promise.race([new Promise(done => server.once('exit', done)), delay(3000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
