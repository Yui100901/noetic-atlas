/** Set-scoped grading requirements, using an owned memory DB and loopback model. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const relaxed = '基础练习：核心概念正确即可，允许等价表述，遗漏次要细节可判部分正确。';
const strict = '进阶考试：必须说明事务整体提交与失败回滚，区分原子性和隔离性。';
const h = await startBrowserHarness({
  name: 'paper-grading-ui',
  setup: String.raw`
const {createServer}=await import('node:http');
const {learningSeed}=await import('./tests/fixtures/learning-seed.ts');
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<300,url+': '+response.body);return response.json();};
const requests=[];
app.get('/qa/grading-requests',async()=>requests);
await api('/api/import','POST',{mode:'merge',data:learningSeed()});
const provider=createServer(async(req,res)=>{try{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),content=body.messages[1].content;
 const input=JSON.parse(typeof content==='string'?content:content[0].text),material=input.untrustedMaterial;
 let result;
 if(input.task.includes('逐项评价')){
  requests.push({kind:'grade',requirements:material.gradingRequirements,ids:material.items.map(item=>item.questionId)});
  result={items:material.items.map(item=>({questionId:item.questionId,verdict:'partial',score:item.maxPoints==null?null:item.maxPoints/2,maxPoints:item.maxPoints,comment:'按本次要求核对：部分要点正确，需补充边界。',strengths:['说明核心概念'],improvements:['补充使用边界']}))};
 }else if(material.candidates){
  requests.push({kind:'paper'});
  result={title:'AI判题要求验收题集',description:'独立验收，不含真实数据',items:material.candidates.slice(0,material.requestedCount).map(item=>({questionId:item.id,reason:'覆盖基础概念'}))};
 }else throw Error('Unexpected model task');
 res.writeHead(200,{'Content-Type':'application/json',Connection:'close'});
 res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
}catch(error){res.writeHead(500,{'Content-Type':'application/json',Connection:'close'});res.end('{}');}});
await new Promise(done=>provider.listen(0,'127.0.0.1',done));
await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'isolated-paper-grading',key:'qa-fixture-only',supportsImages:false,sendImages:false,timeoutSeconds:20,maxTokens:4096});
return{qid:'FIXTURE-SHORT-1'};
`,
});
const { page, origin, state } = h,
  checks = [];
try {
  let navigation = 0;
  const go = async (hash) => {
    await page.goto(origin + '/?grading-qa=' + ++navigation + hash);
  };
  const api = async (path, method = 'GET', payload) => {
    const response = await page.request.fetch(origin + path, {
      method,
      ...(payload === undefined ? {} : { data: payload }),
    });
    assert.ok(response.ok(), path + ': ' + (await response.text()));
    return response.json();
  };
  const requirements = () => page.getByLabel('全卷补充判题要求（可选）', { exact: true });
  const currentPaper = () => decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  const assertNoOverflow = async () => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  };
  await go('#/papers/new/manual');
  await requirements().waitFor();
  assert.equal(await requirements().inputValue(), '');
  assert.equal(await requirements().getAttribute('maxlength'), '10000');
  await page.getByLabel('题集名称 *', { exact: true }).fill('手动判题要求验收');
  await requirements().fill(relaxed);
  await page.getByRole('checkbox', { name: '选择 ' + state.qid, exact: true }).check();
  await page.getByRole('button', { name: '保存组题草稿', exact: true }).click();
  await page.getByText(/组题草稿已保存/).waitFor();
  await page.reload();
  const picker = page.getByRole('dialog', { name: '继续组题草稿', exact: true });
  await picker.waitFor();
  await picker.locator('.authoring-draft-choice > button').first().click();
  assert.equal(await requirements().inputValue(), relaxed);
  assert.equal(
    await page.getByRole('checkbox', { name: '选择 ' + state.qid, exact: true }).isChecked(),
    true,
  );
  checks.push('手动组题默认留空、长度上限明确，判题要求及选题可随草稿恢复');
  await page.getByRole('button', { name: '创建题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/(?!new)[^/?]+$/);
  const paperId = currentPaper();
  assert.equal((await api('/api/papers/' + paperId)).gradingRequirements, relaxed);
  assert.equal((await api('/api/questions/' + state.qid)).gradingRequirements, undefined);
  const summary = page.locator('.paper-grading-requirements');
  await summary.waitFor();
  assert.equal(await summary.getAttribute('open'), null);
  await summary.locator('summary').click();
  assert.equal(await summary.locator('p').innerText(), relaxed);
  checks.push('创建题集保留独立要求，详情默认收起，题库原题不增加要求');

  await page.getByRole('button', { name: '开始练习', exact: true }).click();
  await page.waitForURL(/#\/attempts\/[^/?]+$/);
  const attemptId = decodeURIComponent(new URL(page.url()).hash.split('/')[2]);
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().waitFor();
  assert.equal(await page.locator('.paper-grading-requirements').count(), 0);
  assert.equal(await page.getByText(relaxed, { exact: true }).count(), 0);
  assert.equal((await api('/api/attempts/' + attemptId)).gradingRequirements, undefined);
  checks.push('开始练习冻结要求，作答界面隐藏判题提示');

  await go('#/papers/' + paperId + '/edit');
  await requirements().waitFor();
  assert.equal(await requirements().inputValue(), relaxed);
  await requirements().fill(strict);
  await page.getByRole('button', { name: '保存题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/[^/?]+$/);
  assert.equal((await api('/api/papers/' + paperId)).gradingRequirements, strict);
  assert.equal((await api('/api/attempts/' + attemptId)).gradingRequirements, undefined);
  await api('/api/attempts/' + attemptId + '/submit', 'POST', {
    answers: { [state.qid]: { value: '整体提交或回滚。' } },
  });
  await go('#/attempts/' + attemptId);
  const frozen = page.locator('.paper-grading-requirements');
  await frozen.waitFor();
  await frozen.locator('summary').click();
  assert.equal(await frozen.locator('p').innerText(), relaxed);
  await page.getByRole('button', { name: 'AI评价本题', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'AI评价这道主观题', exact: true });
  const temporary = modal.getByLabel('本次判题要求（可选）', { exact: true });
  assert.equal(await temporary.inputValue(), relaxed);
  await modal.getByRole('button', { name: '生成 1 题的建议评价', exact: true }).click();
  await modal.getByText('按本次要求核对：部分要点正确，需补充边界。', { exact: true }).waitFor();
  assert.equal(
    (await api('/qa/grading-requests')).filter((item) => item.kind === 'grade').at(-1).requirements,
    relaxed,
  );
  checks.push('修改题集不影响旧作答，交卷后的AI默认预填并使用冻结要求');
  await temporary.fill('');
  await modal.getByRole('button', { name: '生成 1 题的建议评价', exact: true }).click();
  await page.waitForFunction(async () => {
    const value = await fetch('/qa/grading-requests').then((response) => response.json());
    return value.filter((item) => item.kind === 'grade').length === 2;
  });
  await modal.getByRole('button', { name: '生成 1 题的建议评价', exact: true }).waitFor();
  assert.equal(
    (await api('/qa/grading-requests')).filter((item) => item.kind === 'grade').at(-1).requirements,
    '',
  );
  assert.equal((await api('/api/papers/' + paperId)).gradingRequirements, strict);
  assert.equal((await api('/api/attempts/' + attemptId)).gradingRequirements, relaxed);
  checks.push('单次AI评价可清空要求，不写回题集或作答快照');

  await go('#/papers/' + paperId + '/questions/' + state.qid);
  const assistant = page.getByRole('region', { name: 'AI学习助手', exact: true });
  await assistant.waitFor();
  await assistant.getByRole('tab', { name: /AI评价回答/ }).click();
  assert.equal(
    await assistant.getByLabel('本次判题要求（可选）', { exact: true }).inputValue(),
    strict,
  );
  await go('#/questions/' + state.qid);
  await assistant.waitFor();
  await assistant.getByRole('tab', { name: /AI评价回答/ }).click();
  assert.equal(
    await assistant.getByLabel('本次判题要求（可选）', { exact: true }).inputValue(),
    '',
  );
  checks.push('题集阅读AI使用本集要求，知识题库单题无默认附加要求');
  const history = page.locator('.question-history');
  await history.getByRole('button', { name: '本题的详细历史作答', exact: true }).click();
  let record = history.locator('.question-history-record').first();
  await record.locator(':scope > summary').click();
  await record.getByText('当时的全卷补充判题要求', { exact: true }).click();
  assert.equal(await record.locator('.paper-grading-requirements p').innerText(), relaxed);
  checks.push('知识题库详细历史展示当时的判题要求，不混用题集现值');
  const latest = await api('/api/papers/' + paperId + '/attempts', 'POST', {});
  await api('/api/attempts/' + latest.id + '/submit', 'POST', {
    answers: { [state.qid]: { value: '新的严格练习回答。' } },
  });
  const nextSettings = { ...(await api('/api/settings')), maxHistoryPerPaper: 1 };
  const prune = await page.request.put(origin + '/api/settings', {
    data: { settings: nextSettings },
  });
  if (prune.status() === 409) {
    const preview = await prune.json();
    assert.equal(preview.error.code, 'RETENTION_CONFIRMATION_REQUIRED');
    await api('/api/settings', 'PUT', {
      settings: nextSettings,
      confirmedRetention: true,
      expectedRetention: preview.error.details,
    });
  } else assert.ok(prune.ok(), await prune.text());
  assert.equal((await page.request.get(origin + '/api/attempts/' + attemptId)).status(), 404);
  await page.reload();
  await page
    .locator('.question-history')
    .getByRole('button', { name: '本题的详细历史作答', exact: true })
    .click();
  record = page.locator('.question-history-record').nth(1);
  await record.locator(':scope > summary').click();
  await record.getByText('当时的全卷补充判题要求', { exact: true }).click();
  assert.equal(await record.locator('.paper-grading-requirements p').innerText(), relaxed);
  await record.getByText('整卷历史已清理，本题完整作答仍保留。', { exact: true }).waitFor();
  await record.screenshot({ path: resolve(h.folder, 'history-grading-after-prune.png') });
  checks.push('隔离库裁剪整卷历史后，单题历史仍显示原要求和完整作答');

  await go('#/papers/' + paperId + '/edit');
  await requirements().waitFor();
  await requirements().fill('');
  await page.getByRole('button', { name: '保存题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/[^/?]+$/);
  assert.equal((await api('/api/papers/' + paperId)).gradingRequirements || '', '');
  assert.equal(await page.locator('.paper-grading-requirements').count(), 0);
  checks.push('编辑题集可清空要求，无要求时详情不显示空卡片');

  await go('#/papers/new/random');
  await requirements().waitFor();
  await page.getByLabel('题集名称 *', { exact: true }).fill('随机判题要求验收');
  await requirements().fill('随机基础练习，允许等价表达。');
  await page.getByLabel('题目数量', { exact: true }).fill('2');
  await page.getByRole('button', { name: '创建题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/(?!new)[^/?]+$/);
  assert.equal(
    (await api('/api/papers/' + currentPaper())).gradingRequirements,
    '随机基础练习，允许等价表达。',
  );
  checks.push('随机组题使用相同可选判题要求并保存');

  await go('#/ai?tab=paper');
  await page.getByLabel('AI组题要求', { exact: true }).waitFor();
  await page.getByLabel('AI组题要求', { exact: true }).fill('从已有题库选2道基础题。');
  await page.getByLabel('手动指定题量', { exact: true }).check();
  await page.getByLabel('推荐题量（组合题整组计）', { exact: true }).fill('2');
  await page.getByRole('button', { name: '生成推荐组题预览', exact: true }).click();
  await page.getByRole('button', { name: '确认创建题集', exact: true }).waitFor();
  await requirements().fill('AI推荐题集采用严格表述要求。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  await page.waitForFunction(async () => {
    const rows = await fetch('/api/ai/workspace-drafts?kind=paper').then((response) =>
      response.json(),
    );
    return rows.some((item) => item.state.gradingRequirements === 'AI推荐题集采用严格表述要求。');
  });
  await page.reload();
  await page
    .getByRole('dialog', { name: '继续AI辅助草稿', exact: true })
    .getByRole('button', { name: '继续此草稿', exact: true })
    .first()
    .click();
  await requirements().waitFor();
  assert.equal(await requirements().inputValue(), 'AI推荐题集采用严格表述要求。');
  assert.equal(
    (await api('/qa/grading-requests')).filter((item) => item.kind === 'paper').length,
    1,
  );
  checks.push('AI辅助草稿保留确认区要求，刷新恢复不重新调用模型');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await requirements().scrollIntoViewIfNeeded();
  await assertNoOverflow();
  await page.screenshot({ path: resolve(h.folder, 'ai-grading-mobile-dark.png') });
  await page.getByRole('button', { name: '确认创建题集', exact: true }).click();
  await page.waitForURL(/#\/papers\/[^/?]+$/);
  assert.equal(
    (await api('/api/papers/' + currentPaper())).gradingRequirements,
    'AI推荐题集采用严格表述要求。',
  );
  await assertNoOverflow();
  checks.push('AI推荐确认可设判题要求，390px暗色编辑及题集详情无横向溢出');
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
