import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'reader-ai-ui',
  setup: String.raw`
 const{createServer}=await import('node:http');const{learningSeed}=await import('./tests/fixtures/learning-seed.ts');
 const seed=learningSeed(),q=seed.questions.find(q=>q.id==='FIXTURE-SHORT-1');q.stemMarkdown='题集保存的原子性问题';q.answerMarkdown='题集保存的参考答案';
 const api=async(url,method='GET',payload)=>{const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<300,r.body);return r.json();};
 await api('/api/import','POST',{mode:'merge',data:seed});
 const paper=await api('/api/papers','POST',{title:'AI快照题集',mode:'manual',questionIds:[q.id,'FIXTURE-BOOL']});
 const current=await api('/api/questions/'+q.id);await api('/api/questions/'+q.id,'PUT',{...current,stemMarkdown:'知识题库中的新问题',answerMarkdown:'知识题库中的新参考答案'});
 const provider=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));const content=envelope.messages[1].content,input=JSON.parse(typeof content==='string'?content:content[0].text),m=input.untrustedMaterial;
 const result=m.items?{items:m.items.map(i=>({questionId:i.questionId,verdict:'partial',score:i.maxPoints==null?null:i.maxPoints/2,maxPoints:i.maxPoints,comment:'评价依据：'+i.question.answerMarkdown,strengths:['说明了概念'],improvements:['补充使用场景']}))}:{explanationMarkdown:'解析依据：'+m.question.stemMarkdown,followUpsMarkdown:'补充推导',pitfallsMarkdown:'补充边界'};
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));}catch(e){res.writeHead(500);res.end('{}');}});
 await new Promise(done=>provider.listen(0,'127.0.0.1',done));
 await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'isolated-reader-qa',key:'fixture-only',supportsImages:false,sendImages:false,timeoutSeconds:20,maxTokens:4096});return{paperId:paper.id,qid:q.id};
`,
});
const { page, state, origin } = h,
  checks = [];
try {
  const go = async (hash) => {
    await page.goto(origin + '/?reader-ai=' + Date.now() + hash);
    await page.getByRole('region', { name: 'AI学习助手', exact: true }).waitFor();
  };
  const panel = () => page.getByRole('region', { name: 'AI学习助手', exact: true });
  const explain = () => panel().getByRole('tabpanel', { name: 'AI解析', exact: false });
  const grade = () => panel().getByRole('tabpanel', { name: 'AI评价回答', exact: false });
  await go(`#/papers/${state.paperId}/questions/${state.qid}`);
  await page
    .locator('.question-viewer-reading')
    .getByText('题集保存的原子性问题', { exact: true })
    .waitFor();
  assert.match(await page.locator('.question-viewer-reading').innerText(), /题集保存的原子性问题/);
  assert.equal(await panel().getByRole('tab').count(), 2);
  assert.equal(await grade().count(), 0);
  checks.push('set reader uses shared reading and separate accessible AI tabs');
  await panel()
    .getByRole('tab', { name: /AI评价回答/ })
    .click();
  await grade()
    .getByRole('textbox', { name: '交给 AI 评价的回答', exact: true })
    .fill('事务应整体成功或回滚');
  await panel()
    .getByRole('tab', { name: /AI解析/ })
    .click();
  assert.equal(await grade().count(), 0);
  await explain().getByRole('button', { name: '生成 AI 解析', exact: true }).click();
  await explain().getByText('解析依据：题集保存的原子性问题', { exact: true }).waitFor();
  checks.push('explanation analyses the saved set version even when the original was edited');
  await page.getByRole('textbox', { name: '我的学习笔记', exact: true }).fill('先保留我手写的理解');
  await explain().getByRole('button', { name: '追加到学习笔记', exact: true }).click();
  await page.waitForFunction(() => {
    const a = document.querySelector('.question-viewer-notes textarea');
    return a?.value.includes('AI 辅助解析');
  });
  let question = await (await page.request.get(origin + '/api/questions/' + state.qid)).json();
  assert.ok(question.study.notes.includes('先保留我手写的理解'));
  assert.ok(question.study.notes.includes('AI 辅助解析'));
  checks.push('appending AI explanation first saves handwritten notes');
  await panel()
    .getByRole('tab', { name: /AI评价回答/ })
    .click();
  assert.equal(
    await grade().getByRole('textbox', { name: '交给 AI 评价的回答', exact: true }).inputValue(),
    '事务应整体成功或回滚',
  );
  await grade().getByRole('button', { name: '评价本次回答', exact: true }).click();
  await grade().getByText('评价依据：题集保存的参考答案', { exact: true }).waitFor();
  await grade().getByText('部分正确', { exact: true }).waitFor();
  checks.push(
    'draft answer survives tab switches; evaluation uses saved reference and returns verdict',
  );
  await grade().getByRole('button', { name: '选中评价追加到笔记', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.question-viewer-notes textarea')?.value.includes('AI 作答评价'),
  );
  question = await (await page.request.get(origin + '/api/questions/' + state.qid)).json();
  assert.equal(question.study.wrongCount, 0);
  checks.push('standalone evaluation appends notes without creating a scored attempt');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await panel().screenshot({ path: resolve(h.folder, 'ai-tabs-mobile-dark.png') });
  checks.push('390px dark theme has distinct tabs without horizontal overflow');
  await go('#/questions/' + state.qid);
  await page.getByText('知识题库中的新问题', { exact: true }).waitFor();
  assert.ok(
    (await page.locator('.question-body').first().innerText()).includes('知识题库中的新问题'),
  );
  await explain().getByRole('button', { name: '生成 AI 解析', exact: true }).click();
  await explain().getByText('解析依据：知识题库中的新问题', { exact: true }).waitFor();
  checks.push('library reader shares the same component but analyses the live source');
  await go(`#/papers/${state.paperId}/questions/FIXTURE-BOOL`);
  await panel()
    .getByRole('tab', { name: /AI评价回答/ })
    .click();
  await grade()
    .getByText(/客观题|选择、判断、填空题/)
    .waitFor();
  assert.equal(await grade().getByRole('button', { name: '评价本次回答' }).count(), 0);
  checks.push('objective types explain local checking instead of offering an invalid grading call');
  h.assertClean();
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify(
      { checks, passed: checks.length, errors: h.errors, external: h.external },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
