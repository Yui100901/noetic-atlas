/** Isolated source/learning workflows. Never opens the operator DB or service. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const harness = await startBrowserHarness({
  name: 'document-citations-ui',
  setup: String.raw`
const api=async(url,method='GET',payload,status=200)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,status,response.body);return response.json();};
await api('/api/documents','POST',{id:'book',title:'变量与表达式教材',kind:'书籍',bodyMarkdown:'# 变量概念\n\n变量把名称与值关联。\n\n表达式产生值。\n\n程序阅读需要核对上下文。'},201);
const book=await api('/api/documents/book');
const source={documentId:'book',versionId:book.contentVersion,title:book.title,relation:'summarized',label:'第一章',startOffset:9,endOffset:22,excerpt:''};
for(let i=0;i<12;i++){const question=await api('/api/questions','POST',{id:'Q'+i,title:'变量概念练习'+i,type:'short_answer',stemMarkdown:'请说明变量名称与值之间的关系。',answerMarkdown:'名称与值关联。',documentLinks:[source]},201);await api('/api/questions/review','POST',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});}
const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();for(let i=1;i<=3;i++){const page=pdf.addPage([400,500]);page.drawText('Source page '+i,{x:40,y:400,size:24});}
const asset=await api('/api/assets','POST',{filename:'textbook.pdf',mimeType:'application/pdf',dataBase64:Buffer.from(await pdf.save()).toString('base64')},201);
await api('/api/documents','POST',{id:'pdf',title:'原文PDF示例',format:'pdf',assetId:asset.id,fileName:'textbook.pdf'},201);const pdfBook=await api('/api/documents/pdf');
const pdfQuestion=await api('/api/questions','POST',{id:'PDF-Q',title:'PDF第二页练习',type:'short_answer',stemMarkdown:'指出教材中的页码。',answerMarkdown:'文件第二页。',documentLinks:[{documentId:'pdf',versionId:pdfBook.contentVersion,title:pdfBook.title,relation:'extracted',label:'页码示例',pageStart:2,pageEnd:2,excerpt:''}]},201);
await api('/api/questions/review','POST',{ids:['PDF-Q'],action:'approve',confirmed:true,expectedUpdatedAt:{'PDF-Q':pdfQuestion.updatedAt}});
const {createServer}=await import('node:http');const provider=createServer(async(request,response)=>{let text='';for await(const chunk of request)text+=chunk;const body=JSON.parse(text),input=JSON.parse(body.messages[1].content);const value=input.task.includes('总结本次资料块')?{title:'变量章节',summary:'本章介绍变量和值。',topics:['变量']}:{questions:[{title:'教材自动生成的变量题',type:'short_answer',stemMarkdown:'变量将什么关联在一起？',answerMarkdown:'名称与值。',explanationMarkdown:'根据本次教材正文。'}],taxonomySuggestions:{domains:[],categories:[],tags:[]}};response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));});await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'isolated-source-qa',key:'test-only',supportsImages:false,sendImages:false,timeoutSeconds:10,maxTokens:4096});
return {version:book.contentVersion,source,pdfVersion:pdfBook.contentVersion};`,
});
const { page, origin, folder } = harness,
  checks = [];
const api = (path, method = 'GET', body) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { path, method, body },
  );
const open = async (hash) => {
  await page.goto(origin + '/' + hash);
  await page.locator('main').waitFor();
};
const wait = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Condition timed out');
};
try {
  await open('#/questions/Q0?returnTo=' + encodeURIComponent('#/questions?search=变量&page=2'));
  await page.getByRole('link', { name: '查看原文', exact: true }).click();
  await page.locator('.source-located-block').first().waitFor();
  assert.ok(
    (await page.locator('.source-located-block').allTextContents()).join('').includes('变量'),
  );
  await page.screenshot({ path: resolve(folder, 'markdown-source.png'), fullPage: true });
  await page.getByRole('link', { name: '返回来源页面', exact: true }).click();
  assert.ok(page.url().includes('/questions/Q0?'));
  checks.push('题目跳原文段落、高亮、保留原题库筛选返回');

  await open('#/documents/book');
  const related = page.getByRole('region', { name: '原文关联题目' });
  await related.getByText('12 题', { exact: true }).waitFor();
  await related.getByRole('link', { name: '变量概念练习0', exact: true }).click();
  await page.getByRole('link', { name: '返回资料', exact: true }).click();
  await page.getByRole('heading', { name: '变量与表达式教材', exact: true }).waitFor();
  checks.push('资料反查关联题目、分页、返回资料上下文');

  await page.getByRole('link', { name: '新增关联题目', exact: true }).click();
  await page
    .locator('[aria-label="题目原文关联编辑"]')
    .getByText('变量与表达式教材', { exact: true })
    .waitFor();
  await page.getByLabel('标题 *', { exact: true }).fill('手动关联的教材问题');
  await page
    .getByRole('textbox', { name: '题干 Markdown', exact: true })
    .fill('表达式的求值结果是什么？');
  await page.getByLabel('引用关系', { exact: true }).selectOption('summarized');
  await page.getByLabel('原文段落', { exact: true }).selectOption({ label: '3. 表达式产生值。' });
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page
    .locator('.question-citations')
    .getByText('依据原文总结 · 原文段落', { exact: true })
    .waitFor();
  let manualId = decodeURIComponent(new URL(page.url()).hash.split('/')[2].split('?')[0]);
  assert.equal(
    (await api('/api/questions/' + encodeURIComponent(manualId))).documentLinks[0].excerpt.trim(),
    '表达式产生值。',
  );
  checks.push('从资料新增题目、选择引用关系与精确段落并保存待审核');

  const book = await api('/api/documents/book');
  await api('/api/documents/book', 'PUT', {
    ...book,
    bodyMarkdown: '新版正文，用于验证引用不会漂移。',
  });
  await open('#/questions/Q0');
  await page.getByRole('link', { name: '查看原文', exact: true }).click();
  await page
    .getByText('教材正文已有更新，正在显示题目引用时的版本，未替换为新版。', { exact: true })
    .waitFor();
  assert.ok((await page.locator('.reading-card').textContent()).includes('表达式产生值。'));
  checks.push('资料改版后仍显示原引用版本并提示差异');

  await page.setViewportSize({ width: 390, height: 844 });
  await open('#/questions/PDF-Q');
  await page.getByRole('link', { name: '查看原文', exact: true }).click();
  await page.getByLabel('PDF文件页码', { exact: true }).waitFor();
  await wait(
    async () =>
      (await page.getByLabel('PDF文件页码', { exact: true }).inputValue()) === '2' &&
      (await page.locator('canvas').getAttribute('aria-busy')) === 'false',
  );
  assert.ok(
    await page.locator('canvas').evaluate((canvas) => canvas.width > 200 && canvas.height > 200),
  );
  await page
    .getByRole('region', { name: 'PDF原文阅读器' })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await wait(
    async () => (await page.getByLabel('PDF文件页码', { exact: true }).inputValue()) === '3',
  );
  await page
    .getByRole('region', { name: 'PDF原文阅读器' })
    .getByRole('button', { name: '上一页', exact: true })
    .click();
  await page.getByRole('checkbox', { name: '仅当前文件页', exact: true }).check();
  await page.getByText('1 题 · 当前资料版本', { exact: true }).waitFor();
  await page
    .getByRole('region', { name: 'PDF原文阅读器' })
    .getByRole('button', { name: '下一页', exact: true })
    .click();
  await page.getByText('0 题 · 当前资料版本', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('checkbox', { name: '仅当前文件页', exact: true }).isChecked(),
    true,
  );
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('page'), '3');
  await page
    .getByRole('region', { name: 'PDF原文阅读器' })
    .getByRole('button', { name: '上一页', exact: true })
    .click();
  await page.getByText('1 题 · 当前资料版本', { exact: true }).waitFor();
  await page.locator('.toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: resolve(folder, 'pdf-mobile.png'), fullPage: true });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
  );
  checks.push('手机PDF按引用页打开、前后翻页、按页反查及无横向溢出');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await open('#/documents/book');
  await page.getByRole('link', { name: '从本资料出题', exact: true }).click();
  await page.getByText('已关联资料库固定版本，出题后可返回原文核对。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '创建可恢复教材任务', exact: true }).click();
  const jobPanel = page.getByRole('region', { name: '教材分批任务' });
  await jobPanel.waitFor();
  await jobPanel.getByRole('button', { name: 'AI总结选中知识块', exact: true }).click();
  const generate = jobPanel.getByRole('button', {
    name: '为选中知识块生成题目（1块）',
    exact: true,
  });
  await wait(() => generate.isEnabled());
  await generate.click();
  const confirm = jobPanel.getByRole('button', {
    name: '确认选中预览到待审核（1块）',
    exact: true,
  });
  await wait(() => confirm.isEnabled());
  await confirm.click();
  await wait(async () => {
    const data = await api('/api/documents/book/questions?pageSize=100');
    return data.items.some((item) => item.title === '教材自动生成的变量题');
  });
  const generated = (await api('/api/documents/book/questions?pageSize=100')).items.find(
    (item) => item.title === '教材自动生成的变量题',
  );
  assert.equal(generated.status, 'pending');
  assert.equal(generated.documentLinks[0].documentId, 'book');
  checks.push('资料库教材选择、AI总结、出题、确认导入及自动原文关联');

  await api('/api/settings', 'PUT', {
    settings: { ...(await api('/api/settings')), theme: 'dark' },
  });
  await page.setViewportSize({ width: 320, height: 800 });
  await open('#/questions/' + manualId);
  await page.reload();
  await wait(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark'));
  await page.getByRole('link', { name: '查看原文', exact: true }).click();
  await page.locator('.source-located-block').waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
  );
  await page.screenshot({ path: resolve(folder, 'source-mobile-dark.png'), fullPage: true });
  checks.push('320像素暗色原文高亮和关联题布局');
  harness.assertClean();
  await writeFile(
    resolve(folder, 'report.json'),
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  await harness.captureFailure(error, { checks });
  throw error;
} finally {
  await harness.close();
}
