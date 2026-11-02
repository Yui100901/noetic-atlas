/** Real isolated API + deployed UI; never attaches to the operator's database. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'maintenance-ui',
  setup: String.raw`
 const {learningSeed}=await import('./tests/fixtures/learning-seed.ts');const seed=learningSeed();
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bZkAAAAASUVORK5CYII=';
 const assets=['used','orphan'].map(id=>({id,filename:id+'.png',mimeType:'image/png',dataBase64:png,sizeBytes:Buffer.from(png,'base64').length,width:1,height:1,createdAt:'2020-01-01T00:00:00.000Z'}));
 seed.assets=assets;seed.questions.find(q=>q.id==='FIXTURE-BOOL').stemMarkdown+='\n![](/api/assets/used/content)';
 const api=async(url,method='GET',payload)=>{const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<300,r.body);return r.json();};
 await api('/api/import','POST',{mode:'merge',data:seed});
 const papers=[];for(const title of ['维护题集甲','维护题集乙']){const p=await api('/api/papers','POST',{title,mode:'manual',questionIds:['FIXTURE-BOOL']});papers.push(p);const a=await api('/api/papers/'+p.id+'/attempts','POST');await api('/api/attempts/'+a.id+'/submit','POST',{answers:{'FIXTURE-BOOL':{value:'false'}}});}
 await api('/api/study/FIXTURE-BOOL','PUT',{notes:'保留共享笔记',favorite:true});return{paperId:papers[0].id,peerId:papers[1].id};
`,
});
const { page, origin, state } = h,
  checks = [];
let resetRequests = 0;
const noOverflow = async () =>
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    'page must not overflow horizontally',
  );
try {
  await page.goto(origin + '/#/settings?tab=backup');
  await page.getByRole('heading', { name: '数据健康', exact: true }).waitFor();
  await page.getByRole('button', { name: '检查数据库', exact: true }).click();
  await page.getByText(/一致性正常/).waitFor();
  checks.push('health counts and native integrity check');
  await page.screenshot({ path: resolve(h.folder, 'maintenance-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '预览清理范围', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '确认清理旧数据' });
  await dialog.waitFor();
  assert.ok((await dialog.innerText()).includes('本次共1项'));
  assert.equal(
    await dialog.getByRole('button', { name: '确认清理', exact: true }).isDisabled(),
    true,
  );
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.request.get(origin + '/api/assets/orphan/data')).status(), 200);
  checks.push('cleanup preview + explicit confirmation + cancel');
  await page.getByRole('button', { name: '预览清理范围', exact: true }).click();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认清理', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await page.request.get(origin + '/api/assets/orphan/data')).status(), 404);
  assert.equal((await page.request.get(origin + '/api/assets/used/data')).status(), 200);
  checks.push('unused asset cleanup preserves referenced images');
  const panel = page.getByRole('region', { name: '分级重置学习进度' });
  await panel.getByLabel('重置范围', { exact: true }).selectOption('paper');
  await panel.getByRole('radio', { name: '维护题集甲', exact: true }).check();
  await page.route('**/api/maintenance/reset', async (route) => {
    resetRequests++;
    if (resetRequests <= 2)
      return route.fulfill({
        status: resetRequests === 1 ? 409 : 507,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: resetRequests === 1 ? 'LEARNING_RESET_PREVIEW_STALE' : 'LOCAL_STORAGE_FAILED',
            message: resetRequests === 1 ? '预览已变化，请重新预览' : '保存失败，本次修改已撤销',
          },
        }),
      });
    return route.continue();
  });
  const preview = () => panel.getByRole('button', { name: '预览重置范围', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认重置学习进度' }),
    confirm = confirmation.getByRole('button', { name: '确认重置学习进度', exact: true });
  await preview();
  await confirmation.waitFor();
  assert.equal(await confirm.isDisabled(), true);
  await confirmation.getByRole('checkbox').check();
  await confirm.click();
  await confirmation.waitFor({ state: 'hidden' });
  await panel.getByRole('alert').filter({ hasText: '预览已变化' }).waitFor();
  assert.equal(resetRequests, 1);
  checks.push('changed reset preview expires without automatic retry');
  await preview();
  await confirmation.getByRole('checkbox').check();
  await confirm.click();
  await confirmation.getByRole('alert').filter({ hasText: '本次修改已撤销' }).waitFor();
  assert.equal(await confirmation.getByRole('checkbox').isChecked(), false);
  assert.equal(await confirm.isDisabled(), true);
  checks.push('failed persistence clears confirmation and preserves retry context');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  assert.ok(await confirmation.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await page.screenshot({ path: resolve(h.folder, 'reset-mobile.png') });
  await confirmation.getByRole('checkbox').check();
  await confirm.click();
  await confirmation.waitFor({ state: 'hidden' });
  await panel.getByRole('status').waitFor();
  checks.push('mobile confirmation layout and successful scoped reset');
  const question = await (await page.request.get(origin + '/api/questions/FIXTURE-BOOL')).json();
  assert.equal(question.study.wrongCount, 1);
  assert.equal(question.study.favorite, true);
  assert.equal(question.study.notes, '保留共享笔记');
  checks.push('peer learning, notes and favorites survive');
  await page.goto(origin + '/#/papers/' + encodeURIComponent(state.peerId));
  await page.getByRole('button', { name: '题集管理', exact: true }).click();
  await page.getByRole('menuitem', { name: '重置本集学习记录', exact: true }).click();
  await page.getByRole('dialog', { name: '重置本集学习记录' }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  await page.getByRole('button', { name: '预览重置范围', exact: true }).click();
  await confirmation.waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1);
  await noOverflow();
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await page
    .getByRole('dialog', { name: '重置本集学习记录' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  checks.push('set menu reuses a single dialog with the correct source');
  await page.goto(origin + '/#/settings?tab=backup');
  await page.getByRole('heading', { name: '数据健康', exact: true }).waitFor();
  await page.getByText('高级维护与最近操作', { exact: true }).click();
  await page.getByRole('button', { name: '整理数据库空间', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await noOverflow();
  checks.push('database compaction confirmation and mobile maintenance layout');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: resolve(h.folder, 'maintenance-mobile-dark.png'), fullPage: true });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'green'));
  await panel.getByLabel('重置级别', { exact: true }).selectOption('complete');
  await preview();
  await confirmation.waitFor();
  assert.ok((await confirmation.innerText()).includes('包含笔记与收藏的状态'));
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('global complete reset describes notes/favorites removal');
  h.assertClean();
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify(
      { passed: checks.length, checks, resetRequests, errors: h.errors, external: h.external },
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
