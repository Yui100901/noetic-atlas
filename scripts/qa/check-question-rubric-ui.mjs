import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'question-rubric-ui',
  setup: String.raw`
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();
seed.questions.push(fixtureQuestion('RUBRIC-GROUP','group',{parts:[
 {id:'explain',title:'说明原因',type:'short_answer',stemMarkdown:'解释整体回滚。',answerMarkdown:'撤销全部已执行操作。',explanationMarkdown:'保证事务原子性。',options:[],correctAnswers:[]},
 {id:'check',title:'核对结论',type:'true_false',stemMarkdown:'操作应整体完成。',answerMarkdown:'正确',explanationMarkdown:'',options:[],correctAnswers:['true']}
]}));
const response=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:seed}});assert.equal(response.statusCode,200,response.body);
return{};
`,
});
const { page, origin } = h,
  checks = [];
const rubric =
  '### 必要要点\n1. 说明全部提交。\n2. 说明失败时全部回滚。\n\n部分正确：仅说明一个结果。';
try {
  const go = (hash) => page.goto(origin + '/?rubric-source-qa=' + Date.now() + hash);
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(origin + path, {
      method,
      ...(data === undefined ? {} : { data }),
    });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  await go('#/questions/FIXTURE-SHORT-1/edit');
  const field = page.getByLabel('原题判题要求', { exact: true });
  await field.waitFor();
  assert.equal(await field.getAttribute('maxlength'), '10000');
  assert.match(await field.getAttribute('placeholder'), /必要要点：…\n正确：/);
  assert.doesNotMatch(await field.getAttribute('placeholder'), /\\n/);
  await field.fill(rubric);
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page.waitForURL(/#\/questions\/FIXTURE-SHORT-1$/);
  assert.equal((await api('/api/questions/FIXTURE-SHORT-1')).gradingRequirements, rubric);
  assert.equal(await page.locator('.question-grading-requirements').count(), 0);
  await page.getByRole('button', { name: '展开答案与解析', exact: true }).click();
  await page.locator('.question-grading-requirements').first().locator('summary').click();
  await page.locator('#reference-answer').getByText('说明全部提交。', { exact: true }).waitFor();
  checks.push('原题标准支持统一Markdown编辑、保存及在展开参考答案后查看');
  await go('#/questions/RUBRIC-GROUP/edit');
  await page
    .getByLabel('小题1原题判题要求', { exact: true })
    .fill('必须说明撤销全部已执行操作；只说失败为部分正确。');
  assert.equal(await page.getByLabel('小题2原题判题要求', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page.waitForURL(/#\/questions\/RUBRIC-GROUP$/);
  assert.match((await api('/api/questions/RUBRIC-GROUP')).parts[0].gradingRequirements, /撤销全部/);
  checks.push('组合题按主观小题编辑，客观小题没有主观标准输入');
  const paper = await api('/api/papers', 'POST', {
    title: '源标准隔离验收',
    mode: 'manual',
    questionIds: ['FIXTURE-SHORT-1'],
    scoring: { enabled: false },
  });
  const attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST');
  await go('#/attempts/' + attempt.id);
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().waitFor();
  assert.equal(await page.locator('.question-grading-requirements').count(), 0);
  assert.equal(
    (await api('/api/attempts/' + attempt.id)).questions[0].gradingRequirements,
    undefined,
  );
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', {
    answers: { 'FIXTURE-SHORT-1': { value: '全部提交，失败时全部回滚。' } },
  });
  const source = await api('/api/questions/FIXTURE-SHORT-1');
  await api('/api/questions/FIXTURE-SHORT-1', 'PUT', {
    ...source,
    gradingRequirements: '后来修改的新标准。',
  });
  await go('#/attempts/' + attempt.id);
  const frozen = page.locator('.question-grading-requirements').first();
  await frozen.waitFor();
  await frozen.locator('summary').click();
  await frozen.getByText('说明全部提交。', { exact: true }).waitFor();
  assert.equal(await page.getByText('后来修改的新标准。', { exact: true }).count(), 0);
  checks.push('作答期间API和页面隐藏逐题标准，交卷后保留当时标准');
  await page.setViewportSize({ width: 390, height: 844 });
  await go('#/questions/FIXTURE-SHORT-1/edit');
  await field.waitFor();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await field.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(h.folder, 'source-rubric-mobile-dark.png') });
  checks.push('390px暗色原题标准编辑无横向溢出');
  h.assertClean();
  const report = {
    passed: checks.length,
    checks,
    errors: h.errors,
    external: h.external,
    database: ':memory:',
  };
  await writeFile(resolve(h.folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
