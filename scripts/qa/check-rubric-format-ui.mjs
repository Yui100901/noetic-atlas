/** Generated Markdown acceptance: owned memory fixtures only, no working DB. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'rubric-format-ui',
  setup: String.raw`
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const {buildSubjectiveRubric}=await import('./scripts/content/grading-rubrics.ts');
const {inspectRubricFormat}=await import('./shared/questions/rubric-format.ts');
const fence=String.fromCharCode(96).repeat(3);
const seed=learningSeed();
const sources=[
 fixtureQuestion('FMT-CODE','short_answer',{title:'核对求和函数',stemMarkdown:'给出求和函数并说明返回值。',answerMarkdown:'返回两数之和。\n\n'+fence+'js\nconst total = left + right;\nreturn total;\n'+fence,explanationMarkdown:'返回值不能是两数之差。'}),
 fixtureQuestion('FMT-LABEL','short_answer',{title:'核对事务结果',stemMarkdown:'解释事务整体完成的含义。',answerMarkdown:'**核心结论**：\n- 全部成功时一起提交。\n- 任一步失败则整体回滚。\n\n**边界**：\n- 不能只回滚最后一步。',explanationMarkdown:'不能将原子性等同于并发操作顺序。'}),
 fixtureQuestion('FMT-LIST','short_answer',{title:'区分两个条件',stemMarkdown:'列出正确执行的两个条件。',answerMarkdown:'1. 输入必须满足范围条件。\n   - 范围下界为零。\n   - 上界由题设给出。\n2. 输出须等于输入之和。',explanationMarkdown:''}),
 fixtureQuestion('FMT-WORD','short_answer',{title:'run',stemMarkdown:'解释run的含义和搭配。',answerMarkdown:'**词性**：verb\n\n**中文释义**：跑；快速移动',explanationMarkdown:'### 使用方式／搭配\n- run + 状语\n- run to + 地点',vocabulary:{language:'en',headword:'run',meaningPrompt:'跑；快速用脚移动',acceptedAnswers:['run'],pronunciations:[{label:'英式',ipa:'/rʌn/',sourceLabel:'fixture',sourceUrl:'https://example.test/fixture',license:'test',method:'manual'}]}}),
 fixtureQuestion('FMT-FIVE','short_answer',{title:'泛型参数必须显示',answerMarkdown:'List<Integer> 不能赋给 List<Number>。',explanationMarkdown:''}),
 fixtureQuestion('FMT-SIX','short_answer',{title:'公式记号必须保留',mathEnabled:true,answerMarkdown:'质量与能量的关系为 $E=mc^2$。',explanationMarkdown:'不能将能量E与质量m互换。'}),
];
for(const question of sources){
 question.gradingRequirements=buildSubjectiveRubric(question,question,['计算机与软件']).gradingRequirements;
 assert.deepEqual(inspectRubricFormat(question.gradingRequirements),[],question.id+' generated malformed Markdown');
}
seed.questions=sources;
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<300,url+': '+response.body);return response.json();};
await api('/api/import','POST',{mode:'merge',data:seed});
const paper=await api('/api/papers','POST',{title:'判题标准格式隔离验收',mode:'manual',questionIds:sources.map(q=>q.id),scoring:{enabled:false}});
return{paperId:paper.id};
`,
});

const { page, origin, state } = h,
  checks = [];
try {
  let nav = 0;
  const go = (hash) => page.goto(`${origin}/?format-qa=${++nav}${hash}`);
  const waitMarkdown = () =>
    page.waitForFunction(() =>
      [...document.querySelectorAll('[role=status]')].every(
        (node) => !node.textContent?.includes('正在排版内容'),
      ),
    );
  const noEmptyLists = async (locator) => {
    assert.equal(
      await locator.locator('li').evaluateAll(
        (items) =>
          items.filter((item) => {
            if (!item.textContent?.trim()) return true;
            const children = [...item.children];
            return (
              children.length > 0 &&
              children.every((child) => ['OL', 'UL'].includes(child.tagName)) &&
              [...item.childNodes].every(
                (child) => child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim(),
              )
            );
          }).length,
      ),
      0,
      'No empty or unnamed parent list items',
    );
  };
  const openStandard = async () => {
    await page.getByRole('button', { name: '展开答案与解析', exact: true }).click();
    const standard = page.locator('#reference-answer .question-grading-requirements').first();
    await standard.waitFor();
    await standard.locator('summary').click();
    await waitMarkdown();
    return standard;
  };
  await go(`#/papers/${state.paperId}/questions/FMT-CODE`);
  let standard = await openStandard();
  assert.equal(await standard.locator('pre > code').count(), 1);
  assert.match(
    await standard.locator('pre > code').innerText(),
    /const total = left \+ right;[\s\S]*return total;/,
  );
  assert.doesNotMatch(
    await standard.locator('pre > code').innerText(),
    /###|必要核对点|词汇作答标准/,
  );
  await noEmptyLists(standard);
  checks.push('生成标准中代码完整保留为单一pre/code，不吞入后续条目');

  await page.getByRole('link', { name: '下一题', exact: true }).click();
  await page.waitForURL(/FMT-LABEL/);
  standard = await openStandard();
  await noEmptyLists(standard);
  assert.match(await standard.innerText(), /全部成功|整体回滚/);
  checks.push('题集下一题保持独立标准，中文标签与多行条目无空编号');

  await go(`#/papers/${state.paperId}/questions/FMT-WORD`);
  standard = await openStandard();
  await noEmptyLists(standard);
  assert.match(await standard.innerText(), /run|跑/);
  checks.push('英语词卡的原搭配列表不生成只有子列表的空父项');

  await go(`#/papers/${state.paperId}/edit`);
  await page.getByRole('button', { name: '全卷预览与调整', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '全卷预览与调整', exact: true });
  await dialog.waitFor();
  await waitMarkdown();
  assert.equal(await dialog.locator('[data-preview-question]').count(), 5);
  const codeStandard = dialog.locator(
    '[data-preview-question="FMT-CODE"] .preview-original-rubric',
  );
  await codeStandard.locator('pre > code').waitFor();
  assert.match(await codeStandard.locator('pre > code').innerText(), /const total = left \+ right/);
  await noEmptyLists(codeStandard);
  const genericStandard = dialog.locator(
    '[data-preview-question="FMT-FIVE"] .preview-original-rubric',
  );
  assert.match(await genericStandard.innerText(), /List<Integer>/);
  assert.match(await genericStandard.innerText(), /List<Number>/);
  checks.push('泛型参数作为代码或字面文本显示，不会被当作HTML隐藏');
  await dialog
    .getByRole('button', { name: /下一页/ })
    .first()
    .click();
  await dialog.locator('[data-preview-question="FMT-SIX"]').waitFor();
  await waitMarkdown();
  assert.equal(await dialog.locator('[data-preview-question]').count(), 1);
  await dialog
    .locator('[data-preview-question="FMT-SIX"] .preview-original-rubric .katex')
    .first()
    .waitFor();
  await dialog.getByRole('button', { name: '上一页', exact: true }).first().click();
  await codeStandard.waitFor();
  await waitMarkdown();
  assert.equal(await codeStandard.locator('pre > code').count(), 1);
  checks.push('全卷预览使用Markdown排版原标准，服务端翻页后代码及列表仍完整');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await codeStandard.scrollIntoViewIfNeeded();
  await waitMarkdown();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.ok(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: resolve(h.folder, 'rubric-format-mobile-dark.png') });
  checks.push('390px暗色预览长标准和代码不造成横向溢出');
  h.assertClean();
  const report = {
    passed: checks.length,
    checks,
    errors: h.errors,
    external: h.external,
    database: ':memory:',
    model: 'none',
  };
  await writeFile(resolve(h.folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
