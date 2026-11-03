/** Real authoring UI with synthetic cards and isolated persistence only. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'vocabulary-editor-ui',
  setup: String.raw`
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();
const vocabulary={language:'en',headword:'atlas',meaningPrompt:'收录地理图的图书',acceptedAnswers:['atlas'],pronunciations:[]};
seed.questions.push(fixtureQuestion('WORD-EDIT','short_answer',{title:'atlas',stemMarkdown:'解释atlas。',answerMarkdown:'地图集',explanationMarkdown:'This atlas contains maps.',gradingRequirements:'- 回答地图集即可。',vocabulary}));
seed.questions.push(fixtureQuestion('WORD-ALIAS','short_answer',{title:'mapbook',vocabulary:{...vocabulary,headword:'mapbook',acceptedAnswers:['mapbook']}}));
seed.questions.push(fixtureQuestion('WORD-JA','short_answer',{title:'猫',stemMarkdown:'説明してください。',answerMarkdown:'猫',vocabulary:{language:'ja',headword:'猫',meaningPrompt:'身近な小型の愛玩動物。鳴き声はニャー。',acceptedAnswers:['猫','ねこ'],pronunciations:[{label:'日语',kana:'ねこ',romaji:'neko',sourceLabel:'',sourceUrl:'',license:'',method:'manual'}]}}));
const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:seed}});assert.equal(imported.statusCode,200,imported.body);
const {createServer}=await import('node:http');
const model=createServer(async(request,response)=>{
 let raw='';for await(const chunk of request)raw+=chunk;
 const material=JSON.parse(JSON.parse(raw).messages[1].content).untrustedMaterial;
 assert.equal(material.question.vocabulary.headword,'atlas');
 const result={summary:'完善当前词卡的独立提示',suggestions:[{id:'word-hint',title:'明确地图集释义',reason:'保持原词条与释义，仅调整作答提示。',confidence:'high',changes:{vocabulary:{...material.question.vocabulary,reverseEnabled:true,meaningPrompt:'把多幅地图装订成册的出版物'}}}],warnings:[]};
 response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
});await new Promise(done=>model.listen(0,'127.0.0.1',done));
const configured=await app.inject({method:'PUT',url:'/api/ai/settings',payload:{enabled:true,baseUrl:'http://127.0.0.1:'+model.address().port,model:'synthetic-vocabulary',key:'qa-synthetic-placeholder',timeoutSeconds:30,maxTokens:4096,supportsImages:false,sendImages:false}});assert.equal(configured.statusCode,200,configured.body);
return{};
`,
});
const { page, origin } = h,
  checks = [];
const api = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(origin + path, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const label = (name) => page.getByLabel(name, { exact: true });
const button = (name) => page.getByRole('button', { name, exact: true });
const preview = () => page.getByRole('region', { name: '词汇卡双向预览', exact: true });
const edit = async (id) => {
  await page.goto(origin + '/#/questions/' + id + '/edit');
  await label('词条 *').waitFor();
};
try {
  await edit('WORD-EDIT');
  await page.getByLabel('独立提示重复提醒', { exact: true }).waitFor();
  assert.match(await page.getByLabel('独立提示重复提醒', { exact: true }).innerText(), /mapbook/);
  assert.equal(await label('逆向区分大小写').isChecked(), false);
  checks.push('现有词卡直接编辑，重复释义显示歧义提示，不强制来源与读音');

  let releaseOld;
  const held = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const handler = async (route) => {
    if (route.request().postDataJSON()?.prompt !== '延迟返回的旧提示') return route.fallback();
    await held;
    await route
      .fulfill({
        json: { total: 1, items: [{ id: 'STALE', headword: '迟到旧结果', title: '旧结果' }] },
      })
      .catch(() => {});
  };
  await page.route('**/api/vocabulary/prompt-matches', handler);
  const started = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/vocabulary/prompt-matches') &&
      request.postDataJSON()?.prompt === '延迟返回的旧提示',
  );
  await label('逆向独立释义提示').fill('延迟返回的旧提示');
  await started;
  await label('逆向独立释义提示').fill('收录地理图的图书');
  releaseOld();
  await page.getByLabel('独立提示重复提醒', { exact: true }).waitFor();
  assert.doesNotMatch(
    await page.getByLabel('独立提示重复提醒', { exact: true }).innerText(),
    /迟到旧结果/,
  );
  await page.unroute('**/api/vocabulary/prompt-matches', handler);
  checks.push('重复提示检查取消旧请求，迟到结果不覆盖新提示');

  await label('词性').fill('n.');
  await button('从词条填写标题与题干').click();
  assert.match(await label('题干 Markdown').inputValue(), /n\./);
  await button('撤回填写').click();
  assert.equal(await label('题干 Markdown').inputValue(), '解释atlas。');
  await label('逆向可接受答案').fill('atlas\n\natlas\nmap book\n');
  await button('保存题目').click();
  await page.waitForURL(/#\/questions\/WORD-EDIT$/);
  const saved = await api('/api/questions/WORD-EDIT');
  assert.deepEqual(saved.vocabulary.acceptedAnswers, ['atlas', 'map book']);
  assert.equal(saved.vocabulary.partOfSpeech, 'n.');
  assert.equal(saved.answerMarkdown, '地图集');
  checks.push('显式生成正文可撤回，保存清理空行与重复答案并保留原释义');

  await edit('WORD-EDIT');
  await preview().getByRole('tab', { name: '看义想词', exact: true }).click();
  assert.doesNotMatch(await preview().innerText(), /atlas|This atlas|地图集/);
  await label('试填逆向答案').fill(' ATLAS ');
  await preview().getByRole('button', { name: '试判答案', exact: true }).click();
  await preview().getByText('匹配：本答案将判为正确', { exact: true }).waitFor();
  await label('逆向区分大小写').check();
  await label('试填逆向答案').fill('ATLAS');
  await preview().getByRole('button', { name: '试判答案', exact: true }).click();
  await preview().getByText('未匹配：本答案将判为错误', { exact: true }).waitFor();
  await preview().getByRole('button', { name: '展开预览答案与解析', exact: true }).click();
  await preview().getByText('目标词语：', { exact: true }).waitFor();
  assert.match(await preview().innerText(), /atlas|区分大小写/);
  assert.equal((await api('/api/attempts')).total ?? (await api('/api/attempts')).length, 0);
  checks.push('逆向预览不泄词，实际匹配随设置变化，展开规则且不产生学习记录');

  await label('逆向独立释义提示').fill('atlas 的释义');
  await button('保存题目').click();
  assert.match(page.url(), /\/edit$/);
  assert.equal(
    (await api('/api/questions/WORD-EDIT')).vocabulary.meaningPrompt,
    '收录地理图的图书',
  );
  await label('允许看释义想词语').uncheck();
  await label('逆向独立释义提示').fill('');
  await button('保存题目').click();
  await page.waitForURL(/#\/questions\/WORD-EDIT$/);
  assert.equal((await api('/api/questions/WORD-EDIT')).vocabulary.reverseEnabled, false);
  await edit('WORD-EDIT');
  assert.equal(
    await preview().getByRole('tab', { name: '看义想词', exact: true }).isEnabled(),
    false,
  );
  checks.push('泄露答案阻止保存，关闭逆向可保存空提示且保留顺向');

  await page.setViewportSize({ width: 390, height: 844 });
  await edit('WORD-JA');
  assert.equal(await label('读音 1 假名').inputValue(), 'ねこ');
  await preview().getByRole('button', { name: '展开预览答案与解析', exact: true }).click();
  assert.equal(await preview().getByRole('link').count(), 0);
  await preview().getByRole('tab', { name: '看义想词', exact: true }).click();
  assert.doesNotMatch(await preview().innerText(), /猫|ねこ|neko/);
  await label('试填逆向答案').fill('ねこ');
  await preview().getByRole('button', { name: '试判答案', exact: true }).click();
  await preview().getByText('匹配：本答案将判为正确', { exact: true }).waitFor();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await page.screenshot({ path: resolve(h.folder, 'japanese-mobile-dark.png'), fullPage: true });
  checks.push('日语假名与罗马音可维护，无来源空链接；390px暗色无横向溢出');

  await label('题型').selectOption('essay');
  assert.equal(await label('词条 *').count(), 0);
  await button('保存题目').click();
  await page.waitForURL(/#\/questions\/WORD-JA$/);
  assert.equal((await api('/api/questions/WORD-JA')).vocabulary, undefined);
  checks.push('切换普通题型清理词卡结构，不保留无效元数据');

  await page.goto(origin + '/#/questions/new');
  await label('作为词汇卡').check();
  await label('词条 *').fill('sample');
  await button('从词条填写标题与题干').click();
  await label('参考答案').fill('样本；例子');
  await label('逆向独立释义提示').fill('用于代表某个总体的一部分对象，名词');
  await button('添加读音').click();
  await label('读音 1 音标').fill('/ˈsɑːmpəl/');
  await button('保存题目').click();
  await page.waitForURL(/#\/questions\/q-/);
  const created = await api(
    '/api/questions/' + decodeURIComponent(page.url().split('#/questions/')[1]),
  );
  assert.equal(created.status, 'pending');
  assert.equal(created.vocabulary.pronunciations[0].sourceUrl, '');
  checks.push('新词卡可从空白创建、维护读音，保存仍须正常审核');

  await edit('WORD-EDIT');
  const originalHint = await label('逆向独立释义提示').inputValue();
  await page
    .getByRole('region', { name: 'AI辅助编辑', exact: true })
    .getByRole('button', { name: '分析当前题目', exact: true })
    .click();
  const suggestion = page.locator('[data-edit-suggestion="word-hint"]');
  await suggestion.getByRole('button', { name: '应用本条建议', exact: true }).click();
  assert.match(await suggestion.innerText(), /语言：英语/);
  assert.equal(await label('逆向独立释义提示').inputValue(), '把多幅地图装订成册的出版物');
  assert.equal((await api('/api/questions/WORD-EDIT')).vocabulary.meaningPrompt, originalHint);
  await suggestion.getByRole('button', { name: '撤回本条修改', exact: true }).click();
  assert.equal(await label('逆向独立释义提示').inputValue(), originalHint);
  checks.push('真实AI契约经模拟模型生成词卡建议，可单条应用与撤回且不自动写入原题');
  h.assertClean();
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        errors: h.errors,
        externalRequests: h.external,
        isolated: true,
      },
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
