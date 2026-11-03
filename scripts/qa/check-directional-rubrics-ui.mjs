/** Directional grading rules use isolated card data; no operator DB or model. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'directional-rubrics-ui',
  setup: String.raw`
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();
seed.questions.push(fixtureQuestion('DIR-WORD','short_answer',{title:'atlas',stemMarkdown:'解释atlas的含义。',answerMarkdown:'地图集。',gradingRequirements:'- 释义：地图集。',vocabulary:{language:'en',headword:'atlas',meaningPrompt:'收录地理图幅的图书',acceptedAnswers:['atlas'],pronunciations:[{label:'英式',ipa:'/ˈætləs/',sourceLabel:'fixture',sourceUrl:'https://example.test/atlas',license:'fixture',method:'manual'}]}}));
seed.questions.push(fixtureQuestion('DIR-CONCEPT','short_answer',{title:'沉没成本',stemMarkdown:'解释沉没成本。',answerMarkdown:'已经发生且无法收回的支出。',gradingRequirements:'- 已经发生；当前选择无法收回。',concept:{term:'沉没成本',meaningPrompt:'已经发生且无法收回的支出',acceptedAnswers:['沉没成本','sunk cost']}}));
const response=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:seed}});assert.equal(response.statusCode,200,response.body);return{};
`,
});
const { page, origin } = h,
  checks = [];
try {
  let tick = 0;
  const go = (hash) => page.goto(origin + '/?direction-qa=' + ++tick + hash);
  const api = async (path, method = 'GET', data) => {
    const response = await page.request.fetch(origin + path, {
      method,
      ...(data === undefined ? {} : { data }),
    });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  await go('#/questions/DIR-WORD');
  await page.getByRole('button', { name: '展开答案与解析', exact: true }).click();
  const reference = page.locator('#reference-answer');
  await reference.getByText('正向判题标准：看词语写释义', { exact: true }).waitFor();
  await reference.getByText('逆向判题规则：看释义写词语', { exact: true }).click();
  await reference.getByText(/未列出的同义词、其他词形不自动判对/).waitFor();
  assert.equal(await reference.locator('li').filter({ hasText: '可接受答案' }).count(), 1);
  checks.push('英语词卡明确区分正向释义标准与逆向具体词形及匹配规则');
  await go('#/questions/DIR-CONCEPT');
  await page.getByRole('button', { name: '展开答案与解析', exact: true }).click();
  await reference.getByText('正向判题标准：看概念写释义', { exact: true }).waitFor();
  await reference.getByText('逆向判题规则：看描述写概念', { exact: true }).click();
  await reference.getByText(/可接受答案：/).waitFor();
  assert.match(await reference.innerText(), /sunk cost/);
  checks.push('概念卡逆向列出实际主词和别称，未列近义概念不自动判对');
  await go('#/questions/DIR-WORD/edit');
  await page.getByLabel('正向判题标准：看词语写释义', { exact: true }).waitFor();
  await page.getByText('逆向判题规则：看释义写词语', { exact: true }).click();
  assert.equal(await page.getByLabel('逆向判题规则：看释义写词语', { exact: true }).count(), 0);
  await page.getByText(/逆向按已收录的词形或概念别称客观核对/).waitFor();
  checks.push('源卡编辑仅正向标准可编辑，逆向规则只读并说明其判分依据');
  const paper = await api('/api/papers', 'POST', {
    title: '词卡逆向验证',
    mode: 'manual',
    practiceKind: 'vocabulary',
    questionIds: ['DIR-WORD'],
    scoring: { enabled: false },
  });
  const attempt = await api('/api/papers/' + paper.id + '/attempts', 'POST', {
    vocabularyDirection: 'meaning_to_word',
  });
  await go('#/attempts/' + attempt.id);
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().waitFor();
  assert.equal(await page.locator('.question-grading-requirements').count(), 0);
  const active = await api('/api/attempts/' + attempt.id);
  assert.equal(active.questions[0].vocabulary, undefined);
  assert.equal(active.questions[0].blanks[0].answers, undefined);
  await api('/api/attempts/' + attempt.id + '/submit', 'POST', {
    answers: { 'DIR-WORD': { value: [' ATLAS '] } },
  });
  const old = await api('/api/questions/DIR-WORD');
  await api('/api/questions/DIR-WORD', 'PUT', {
    ...old,
    vocabulary: { ...old.vocabulary, acceptedAnswers: ['atlas-new'] },
  });
  await go('#/attempts/' + attempt.id);
  const reverse = page.locator('.question-grading-requirements');
  await reverse.locator('summary').click();
  await reverse.locator('li').filter({ hasText: '可接受答案' }).waitFor();
  assert.match(await reverse.innerText(), /atlas/);
  assert.doesNotMatch(await reverse.innerText(), /"atlas"/);
  assert.doesNotMatch(await reverse.innerText(), /atlas-new/);
  assert.equal(await page.getByText('正向判题标准：看词语写释义', { exact: true }).count(), 0);
  const doc = await api('/api/attempts/' + attempt.id + '/export-document?mode=completed');
  assert.match(doc.markdown, /逆向判题规则/);
  assert.doesNotMatch(doc.markdown, /atlas-new|正向判题标准/);
  checks.push('逆向答题中不透出规则，提交后按冻结答案显示和导出，原题修改不回灌');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await reverse.scrollIntoViewIfNeeded();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[role=status]')).every(
      (element) => !element.textContent?.includes('正在排版内容'),
    ),
  );
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(h.folder, 'reverse-rules-mobile-dark.png') });
  checks.push('390px暗色逆向规则列表无空项或横向溢出');
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
