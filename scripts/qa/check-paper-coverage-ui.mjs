/** Optional coverage quotas, factual preview and adjustments; no real model. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'paper-coverage-ui',
  setup: String.raw`
const {createServer}=await import('node:http');const {fixtureQuestion,learningSeed}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();seed.questions=[fixtureQuestion('COV-TF-1','true_false'),fixtureQuestion('COV-TF-2','true_false'),fixtureQuestion('COV-SA-1','short_answer'),fixtureQuestion('COV-SA-2','short_answer'),fixtureQuestion('COV-MC-1','multiple_choice'),fixtureQuestion('COV-MC-2','single_choice')];
const api=async(url,method='POST',payload)=>{const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<300,r.body);return r.json();};await api('/api/import','POST',{mode:'merge',data:seed});
const provider=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8')),m=JSON.parse(body.messages[1].content).untrustedMaterial;
const required=m.requiredQuestionIds||[],ids=[...required,...m.candidates.map(q=>q.id).filter(id=>!required.includes(id))].slice(0,m.selectionCount||m.requestedCount);
const result={title:'覆盖核对'+m.paperQuestionCount+'题',description:'按当前覆盖要求选择已有题目。',items:ids.map(questionId=>({questionId,reason:'符合已有题目与覆盖要求'}))};res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));}catch{res.writeHead(500);res.end('{}');}});await new Promise(done=>provider.listen(0,'127.0.0.1',done));
await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'coverage-fixture',key:'fixture-only',supportsImages:false,sendImages:false,timeoutSeconds:20,maxTokens:8192});return{};
`,
});
const { page, origin } = h,
  checks = [];
const button = (name) => page.getByRole('button', { name, exact: true });
const label = (name) => page.getByLabel(name, { exact: true });
try {
  await page.goto(origin + '/#/papers/new/ai');
  await label('AI组题要求').fill('四道题，兼顾判断和简答');
  await label('手动指定题量').check();
  await label('推荐题量（组合题整组计）').fill('4');
  await page.getByText('可选覆盖要求', { exact: true }).click();
  await button('添加覆盖项').click();
  await label('第1项覆盖内容').selectOption('true_false');
  await label('第1项最低题数').fill('2');
  await button('添加覆盖项').click();
  await label('第2项覆盖内容').selectOption('short_answer');
  await label('第2项最低题数').fill('1');
  await button('保存草稿').first().click();
  await page.waitForFunction(async () => {
    const drafts = await fetch('/api/ai/workspace-drafts?kind=paper').then((response) =>
      response.json(),
    );
    return drafts.some(
      (draft) =>
        draft.state.coverage?.rules?.length === 2 && draft.state.coverage.rules[0].minimum === 2,
    );
  });
  await page.reload();
  const picker = page.getByRole('dialog', { name: '继续AI辅助草稿', exact: true });
  await picker.waitFor();
  await picker.getByRole('button', { name: '继续此草稿', exact: true }).first().click();
  await page
    .getByText(/可选覆盖要求/)
    .first()
    .click();
  await label('第1项最低题数').waitFor();
  assert.equal(await label('第1项最低题数').inputValue(), '2');
  checks.push('覆盖要求默认可选，可配置题型最低数并随草稿恢复');
  await button('生成推荐组题预览').click();
  const summary = page.getByRole('region', { name: '题集覆盖情况', exact: true });
  await summary.getByText('已满足全部要求', { exact: true }).waitFor();
  assert.match(await summary.innerText(), /当前4道整题/);
  assert.match(await summary.innerText(), /实际2 \/ 最低2/);
  assert.equal(await button('确认创建题集').isEnabled(), true);
  checks.push('真实推荐流程返回本地核验的覆盖摘要，模型选择满足最低题数');
  await button('COV-TF-1移除').click();
  await summary.getByText('1项未达到', { exact: true }).waitFor();
  assert.equal(await button('确认创建题集').isDisabled(), true);
  await label('从候选范围补充题目').selectOption('COV-TF-1');
  await summary.getByText('已满足全部要求', { exact: true }).waitFor();
  assert.equal(await button('确认创建题集').isEnabled(), true);
  checks.push('预览删题立即出现客观缺口并禁保存，补回候选后恢复达标');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await summary.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: resolve(h.folder, `coverage-${width}.png`), fullPage: true });
  }
  await button('确认创建题集').click();
  await page.waitForURL(/#\/papers\/paper-/);
  checks.push('390/320像素覆盖表与操作无溢出，达标题集可正式保存');
  h.assertClean();
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
