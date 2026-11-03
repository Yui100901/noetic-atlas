/** Bounded editing records: real settings UI, synthetic records and no operator DB. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'question-maintenance-settings-ui',
  setup: String.raw`
const {learningSeed}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed(),question=seed.questions.find(value=>value.id==='FIXTURE-SHORT-1');
const {id,status,createdAt,updatedAt,...content}=question;
const questionDrafts=[],questionRevisions=[];
for(let i=1;i<=3;i++){
 const stamp='2026-10-0'+i+'T00:00:00.000Z';
 questionDrafts.push({id:'limit-draft-'+i,questionId:id,baseUpdatedAt:updatedAt,state:{form:{...content,title:'草稿 '+i,status},sources:'',reason:''},createdAt:stamp,updatedAt:stamp});
 questionRevisions.push({id:'limit-revision-'+i,questionId:id,sequence:i,content:{...content,title:'修订 '+i},origin:'manual',reason:'旧修订 '+i,changedFields:['title'],createdAt:stamp,sourceUpdatedAt:stamp});
}
const result=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{...seed,questionDrafts,questionRevisions}}});assert.equal(result.statusCode,200,result.body);
return {questionId:id};
`,
});
const { page, origin } = h,
  checks = [];
const api = async (path) => {
  const r = await page.request.get(origin + path);
  assert.ok(r.ok(), await r.text());
  return r.json();
};
try {
  const before = await api('/api/questions/' + h.state.questionId);
  await page.goto(origin + '/#/settings?tab=retention&sub=content');
  const drafts = page.getByLabel('每个题目编辑入口最多草稿数', { exact: true });
  const revisions = page.getByLabel('每题最多内容修订版本', { exact: true });
  assert.equal(await drafts.inputValue(), '3');
  assert.equal(await revisions.inputValue(), '20');
  checks.push('系统设置显示题目草稿与修订默认上限3和20，复用已有高级设置');
  await drafts.fill('1');
  await revisions.fill('1');
  await page.getByRole('button', { name: '保存系统配置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认记录保留范围', exact: true });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /题目草稿：2 份/);
  assert.match(await dialog.innerText(), /题目修订版本：2 份/);
  assert.equal((await api('/api/export')).questionDrafts.length, 3);
  assert.equal((await api('/api/export')).questionRevisions.length, 3);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await api('/api/settings')).maxQuestionDrafts, 3);
  checks.push('调低上限先预览两类独立清理数量，取消不会修改配置或维护记录');
  await page.getByRole('button', { name: '保存系统配置', exact: true }).click();
  await dialog.getByRole('button', { name: '确认保存并清理记录', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const after = await api('/api/export');
  assert.deepEqual(
    after.questionDrafts.map((value) => value.id),
    ['limit-draft-3'],
  );
  assert.deepEqual(
    after.questionRevisions.map((value) => value.id),
    ['limit-revision-3'],
  );
  assert.equal((await api('/api/settings')).maxQuestionRevisions, 1);
  assert.deepEqual(await api('/api/questions/' + h.state.questionId), before);
  const configuration = await api('/api/settings/export');
  assert.equal(configuration.system.maxQuestionDrafts, 1);
  assert.equal(Object.hasOwn(configuration, 'questionDrafts'), false);
  assert.equal(Object.hasOwn(configuration, 'questionRevisions'), false);
  checks.push('确认后仅保留各范围最新记录，原题不变，配置迁移不包含私人编辑内容');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await drafts.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(h.folder, 'limits-mobile-dark.png') });
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
