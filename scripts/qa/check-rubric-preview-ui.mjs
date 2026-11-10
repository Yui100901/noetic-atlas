/** Full-paper rubric preview acceptance uses owned memory data and a loopback model. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';
const h = await startBrowserHarness({
  name: 'rubric-preview-ui',
  setup: String.raw`
const {createServer}=await import('node:http');
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<300,url+': '+response.body);return response.json();};
const seed=learningSeed();
seed.questions=seed.questions.map(q=>q.type==='short_answer'?{...q,gradingRequirements:'原题标准：核心概念正确；等价表达可接受；遗漏边界为部分正确。'}:q);
for(let i=1;i<=7;i++)seed.questions.push(fixtureQuestion('PREVIEW-'+i,'short_answer',{gradingRequirements:'第'+i+'题原标准：说明含义、使用条件及一个例子。'}));
seed.questions.push(fixtureQuestion('PREVIEW-GROUP','group',{stemMarkdown:'组合题共用材料：阅读一段事务伪代码。',answerMarkdown:'',explanationMarkdown:'',parts:[{id:'explain',title:'解释回滚',type:'short_answer',stemMarkdown:'说明操作失败后的状态。',answerMarkdown:'整体回滚。',explanationMarkdown:'强调原子性。',options:[],correctAnswers:[],gradingRequirements:'小题原标准：明确整体回滚，不能只撤销最后一步。'},{id:'check',title:'判断结果',type:'true_false',stemMarkdown:'失败后可只撤销最后一步。',answerMarkdown:'错误。',explanationMarkdown:'须保持原子性。',options:[],correctAnswers:['false']}]}));
const calls=[];app.get('/qa/rubric-calls',async()=>calls);
await api('/api/import','POST',{mode:'merge',data:seed});
const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),message=body.messages[1].content,input=JSON.parse(typeof message==='string'?message:message[0].text),material=input.untrustedMaterial;let result;
if(input.task.includes('逐项评价')){calls.push({kind:'grade',items:material.items});result={items:material.items.map(item=>({questionId:item.questionId,verdict:String(item.answer||'').trim()?'partial':'incorrect',score:item.maxPoints==null?null:String(item.answer||'').trim()?item.maxPoints/2:0,maxPoints:item.maxPoints,comment:'按本题标准核对作答。',strengths:[],improvements:['补充边界']}))};}
else if(material.candidates){calls.push({kind:'plan'});result={title:'AI完整预览题集',description:'测试组题',items:material.candidates.filter(q=>q.type==='short_answer').slice(0,material.requestedCount).map(q=>({questionId:q.id,reason:'核对基础概念'}))};}
else throw Error('Unexpected model request');
res.writeHead(200,{'Content-Type':'application/json',Connection:'close'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));});
await new Promise(done=>provider.listen(0,'127.0.0.1',done));
await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'rubric-preview-mock',key:'fixture-only',supportsImages:false,sendImages:false,timeoutSeconds:20,maxTokens:4096});
return{};
`,
});
const { page, origin } = h,
  checks = [];
try {
  let navigation = 0;
  const go = async (hash) => page.goto(origin + '/?rubric-preview=' + ++navigation + hash);
  const api = async (path, method = 'GET', payload, status = 200) => {
    const response = await page.request.fetch(origin + path, {
      method,
      ...(payload === undefined ? {} : { data: payload }),
    });
    assert.equal(response.status(), status, await response.text());
    return response.json();
  };
  const dialog = () => page.getByRole('dialog', { name: '全卷预览与调整', exact: true });
  const openPreview = async () => {
    await page.getByRole('button', { name: '全卷预览与调整', exact: true }).click();
    await dialog().waitFor();
  };
  const closePreview = async () => {
    await dialog().getByRole('button', { name: '保留调整并返回组题', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
  };
  const createName = page.getByLabel('题集名称 *', { exact: true });
  const selected = [
    'FIXTURE-SHORT-1',
    'PREVIEW-GROUP',
    ...Array.from({ length: 6 }, (_, i) => 'PREVIEW-' + (i + 1)),
  ];
  const responses = [];
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/papers/preview') && response.ok()) {
      responses.push(await response.json());
    }
  });
  await go('#/papers/new/manual');
  await createName.fill('逐题标准与全卷预览');
  await page.getByRole('checkbox', { name: '启用计分', exact: true }).check();
  for (const id of selected)
    await page.getByRole('checkbox', { name: '选择 ' + id, exact: true }).check();
  await openPreview();
  assert.equal(await dialog().locator('[data-preview-question]').count(), 5);
  await dialog().getByText('组合题共用材料：阅读一段事务伪代码。', { exact: true }).waitFor();
  await dialog().getByText('整体回滚。', { exact: true }).waitFor();
  assert.equal(
    await dialog().getByLabel('FIXTURE-SHORT-1 判题要求来源', { exact: true }).inputValue(),
    'inherit',
  );
  checks.push('完整预览只加载本页5题，包含组合材料、答案、解析和原题标准');
  const custom = '本集自定义：必须明确全部提交或全部回滚；说明边界可满分，遗漏关键条件为部分正确。';
  await dialog().getByLabel('FIXTURE-SHORT-1 判题要求来源', { exact: true }).selectOption('custom');
  await dialog().getByLabel('FIXTURE-SHORT-1 本集判题要求', { exact: true }).fill(custom);
  await dialog()
    .getByLabel('PREVIEW-GROUP::explain 判题要求来源', { exact: true })
    .selectOption('custom');
  await dialog()
    .getByLabel('PREVIEW-GROUP::explain 本集判题要求', { exact: true })
    .fill('本集小题标准：必须解释事务整体恢复。');
  await dialog()
    .getByRole('button', { name: /下一页/ })
    .first()
    .click();
  await dialog().locator('[data-preview-question="PREVIEW-4"]').waitFor();
  assert.ok(responses.at(-1).previewQuestions.length <= 5);
  assert.equal(responses.at(-1).questionIds.length, 8);
  assert.ok(responses.at(-1).questions.every((q) => !q.stemMarkdown && !q.options.length));
  await dialog().getByRole('button', { name: '上一页', exact: true }).first().click();
  await dialog().getByLabel('FIXTURE-SHORT-1 本集判题要求', { exact: true }).waitFor();
  assert.equal(
    await dialog().getByLabel('FIXTURE-SHORT-1 本集判题要求', { exact: true }).inputValue(),
    custom,
  );
  checks.push('逐题和主观小题自定义跨页保留，响应不含其他页的完整正文');
  await dialog()
    .getByLabel('FIXTURE-SHORT-1 判题要求来源', { exact: true })
    .selectOption('inherit');
  assert.equal(
    await dialog().getByLabel('FIXTURE-SHORT-1 本集判题要求', { exact: true }).count(),
    0,
  );
  await dialog().getByLabel('FIXTURE-SHORT-1 判题要求来源', { exact: true }).selectOption('custom');
  await dialog().getByLabel('FIXTURE-SHORT-1 本集判题要求', { exact: true }).fill(custom);
  const reorderedResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/papers/preview') && response.request().method() === 'POST',
  );
  await dialog().getByRole('button', { name: 'FIXTURE-SHORT-1 下移', exact: true }).click();
  assert.equal((await (await reorderedResponse).json()).questionIds[1], 'FIXTURE-SHORT-1');
  await dialog().getByLabel('FIXTURE-SHORT-1 本集判题要求', { exact: true }).waitFor();
  if (await dialog().getByLabel('FIXTURE-SHORT-1 预览分值', { exact: true }).count())
    await dialog().getByLabel('FIXTURE-SHORT-1 预览分值', { exact: true }).fill('7');
  await closePreview();
  await page.getByRole('button', { name: '保存组题草稿', exact: true }).click();
  await page.getByText(/组题草稿已保存/).waitFor();
  await page.reload();
  await page.getByRole('dialog', { name: '继续组题草稿', exact: true }).waitFor();
  await page.locator('.authoring-draft-choice > button').first().click();
  await openPreview();
  assert.equal(
    await dialog().getByLabel('FIXTURE-SHORT-1 本集判题要求', { exact: true }).inputValue(),
    custom,
  );
  checks.push('可恢复沿用、改变排序和分值，预览修改可随组题草稿恢复');
  await closePreview();
  await page.getByRole('button', { name: '创建题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/(?!new)[^/?]+$/);
  const paperId = decodeURIComponent(new URL(page.url()).hash.split('/')[2]),
    paper = await api('/api/papers/' + paperId);
  assert.equal(paper.questionIds[1], 'FIXTURE-SHORT-1');
  assert.equal(paper.questionGradingRequirements['FIXTURE-SHORT-1'], custom);
  assert.match((await api('/api/questions/FIXTURE-SHORT-1')).gradingRequirements, /原题标准/);
  const attempt = await api('/api/papers/' + paperId + '/attempts', 'POST', undefined, 201);
  await api('/api/attempts/' + attempt.id + '/submit', 'POST', {
    answers: { 'FIXTURE-SHORT-1': { value: '全部提交或全部回滚' } },
  });
  await api('/api/ai/grade', 'POST', { attemptId: attempt.id, questionIds: ['FIXTURE-SHORT-1'] });
  const sent = (await api('/qa/rubric-calls')).filter((call) => call.kind === 'grade').at(-1);
  assert.equal(sent.items[0].gradingRequirements, custom);
  checks.push('保存本集覆盖不修改原题，交卷AI实际收到该题快照标准');

  await go('#/papers/new/random');
  await createName.fill('随机预览锁定');
  await page.getByRole('checkbox', { name: '启用计分', exact: true }).uncheck();
  await page.getByLabel('题目数量', { exact: true }).fill('2');
  await page.getByRole('checkbox', { name: '简答 / 场景', exact: true }).check();
  await openPreview();
  const pinned = responses.at(-1).questionIds;
  assert.equal(pinned.length, 2);
  const pinnedId = pinned[0];
  await dialog()
    .getByLabel(pinnedId + ' 判题要求来源', { exact: true })
    .selectOption('custom');
  await dialog()
    .getByLabel(pinnedId + ' 本集判题要求', { exact: true })
    .fill('随机卷专属标准：术语和结论均须准确。');
  await closePreview();
  await page.getByRole('button', { name: '保存组题草稿', exact: true }).click();
  await page.getByText(/组题草稿已保存/).waitFor();
  await page.reload();
  await page.getByRole('dialog', { name: '继续组题草稿', exact: true }).waitFor();
  await page.locator('.authoring-draft-choice > button').first().click();
  await openPreview();
  assert.deepEqual(responses.at(-1).questionIds, pinned);
  await closePreview();
  await page.getByRole('button', { name: '创建题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/(?!new)[^/?]+$/);
  const randomPaper = await api(
    '/api/papers/' + decodeURIComponent(new URL(page.url()).hash.split('/')[2]),
  );
  assert.deepEqual(randomPaper.questionIds, pinned);
  assert.equal(
    randomPaper.questionGradingRequirements[pinnedId],
    '随机卷专属标准：术语和结论均须准确。',
  );
  checks.push('随机预览、草稿恢复和最终创建保持同批题目及逐题标准');

  await go('#/papers/new/random');
  await createName.fill('条件变化重新抽题');
  await page.getByRole('checkbox', { name: '启用计分', exact: true }).uncheck();
  await page.getByLabel('题目数量', { exact: true }).fill('2');
  await page.getByRole('checkbox', { name: '简答 / 场景', exact: true }).check();
  await openPreview();
  const obsoleteId = responses.at(-1).questionIds[0];
  await dialog()
    .getByLabel(obsoleteId + ' 判题要求来源', { exact: true })
    .selectOption('custom');
  await dialog()
    .getByLabel(obsoleteId + ' 本集判题要求', { exact: true })
    .fill('该旧批次标准应随更换范围作废');
  await closePreview();
  await page.getByLabel('题目数量', { exact: true }).fill('3');
  await page.getByLabel('知识领域', { exact: true }).selectOption('fixture-computer');
  await page.getByText(/之前的随机预览已失效/).waitFor();
  await openPreview();
  assert.equal(responses.at(-1).questionIds.length, 3);
  assert.deepEqual(responses.at(-1).questionGradingRequirements, {});
  await closePreview();
  checks.push('主动更改随机题量或筛选会废弃旧批次及逐题覆盖，草稿恢复不触发该行为');

  await go('#/papers/new/ai');
  await page.getByLabel('AI组题要求', { exact: true }).fill('选择两道事务简答题');
  await page.getByRole('checkbox', { name: '手动指定题量', exact: true }).check();
  await page.getByLabel('推荐题量（组合题整组计）', { exact: true }).fill('2');
  await page.getByRole('button', { name: '生成推荐组题预览', exact: true }).click();
  await page.getByRole('button', { name: '确认创建题集', exact: true }).waitFor();
  await openPreview();
  const aiId = responses
    .at(-1)
    .questionIds.find(
      (id) => responses.at(-1).previewQuestions.find((q) => q.id === id)?.type === 'short_answer',
    );
  assert.ok(aiId, 'AI预览包含主观题');
  if (aiId) {
    await dialog()
      .getByLabel(aiId + ' 判题要求来源', { exact: true })
      .selectOption('custom');
    await dialog()
      .getByLabel(aiId + ' 本集判题要求', { exact: true })
      .fill('AI推荐卷标准：必要术语不得遗漏。');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[role=dialog] [role=status]')).every(
      (element) => !element.textContent?.includes('正在排版内容'),
    ),
  );
  await page.screenshot({ path: resolve(h.folder, 'preview-mobile-dark.png') });
  await closePreview();
  await page.getByRole('button', { name: '确认创建题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/[^/?]+$/);
  if (aiId)
    assert.equal(
      (await api('/api/papers/' + decodeURIComponent(new URL(page.url()).hash.split('/')[2])))
        .questionGradingRequirements[aiId],
      'AI推荐卷标准：必要术语不得遗漏。',
    );
  checks.push('AI推荐确认前可完整预览并保存逐题标准，390px暗色无横向溢出');
  h.assertClean();
  const report = {
    passed: checks.length,
    checks,
    errors: h.errors,
    external: h.external,
    database: ':memory:',
    model: 'loopback-mock',
  };
  await writeFile(resolve(h.folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
