import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataPackage } from '../../shared/packages/data-package.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'sharing-sets-ui',
  staticRoot: process.env.NOETIC_QA_SHARING_ROOT || 'dist/web',
  setup: `
const api=async(url,method='GET',payload)=>{const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<400,r.body);return r.json();};
const {learningSeed}=await import('./tests/fixtures/learning-seed.ts');await api('/api/import','POST',{mode:'merge',data:learningSeed()});
const papers=[];for(let i=0;i<26;i++)papers.push(await api('/api/papers','POST',{title:'批量分享卷 '+String(i).padStart(2,'0'),mode:'manual',questionIds:['FIXTURE-BOOL'],scoring:{enabled:false}}));
await api('/api/papers','POST',{title:'另外一份不应导出',mode:'manual',questionIds:['FIXTURE-MULTI'],scoring:{enabled:false}});
const a=await api('/api/papers/'+papers[0].id+'/attempts','POST',{});await api('/api/attempts/'+a.id+'/submit','POST',{answers:{'FIXTURE-BOOL':{value:'false'}}});
await api('/api/study/FIXTURE-BOOL','PUT',{favorite:true,notes:'PRIVATE_BROWSE_NOTE',nextReviewAt:'2020-01-01T00:00:00.000Z'});
const settings=await api('/api/settings');await api('/api/settings','PUT',{settings:{...settings,reviewScheduling:{...settings.reviewScheduling,strategy:'fixed'}}});
return {paperId:papers[0].id};
`,
});
const { page, origin } = h,
  checks = [];
async function downloaded(button) {
  const [result] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return readDataPackage(new Uint8Array(await readFile(await result.path())));
}
try {
  await page.goto(origin + '/#/papers/' + h.state.paperId);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const paperDialog = page.getByRole('dialog', { name: '分享题集', exact: true });
  await paperDialog.waitFor();
  for (const name of ['PDF 文档', 'Markdown (.md)', '题集数据包（ZIP）'])
    await paperDialog.getByRole('radio', { name, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '导出与分享', exact: true }).count(), 0);
  await paperDialog.getByRole('radio', { name: '题集数据包（ZIP）', exact: true }).check();
  await paperDialog.getByText('导出规模检查通过', { exact: true }).waitFor();
  const packet = await downloaded(
    paperDialog.getByRole('button', { name: '下载文件', exact: true }),
  );
  assert.equal(packet.payloads[0].data.papers.length, 1);
  await paperDialog.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('单个分享入口提供PDF/Markdown/ZIP，真实下载可导入的题集包');
  await page.goto(origin + '/#/papers');
  await page.getByRole('article', { name: '题集：另外一份不应导出', exact: true }).waitFor();
  assert.equal(
    await page.locator('.paper-card-top').getByText('手动选题', { exact: true }).count(),
    0,
  );
  checks.push('题集卡片移除创建方式来源标签');
  for (const kind of ['wrong', 'favorite', 'due']) {
    await page.goto(origin + '/#/learning/' + kind);
    await page.getByRole('button', { name: '分享', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '分享内容', exact: true });
    await dialog.getByText('导出规模检查通过', { exact: true }).waitFor();
    const file = await downloaded(
      dialog.getByRole('button', { name: '导出完整分享数据包（ZIP）', exact: true }),
    );
    assert.equal(file.payloads[0].data.questions.length, 1);
    assert.equal(file.payloads[0].data.papers.length, 0);
    assert.ok(!JSON.stringify(file.payloads).includes('PRIVATE_BROWSE_NOTE'));
    await page.keyboard.press('Escape');
  }
  checks.push('错题/收藏/待复习均有分享入口，包内无私人笔记和作答');
  await page.goto(origin + '/#/sharing?tab=papers');
  await page.getByPlaceholder('搜索题集标题').fill('批量分享卷');
  const area = page.getByRole('region', { name: '筛选与批量分享题集', exact: true });
  await area.getByRole('button', { name: '分享全部筛选结果 26 份', exact: true }).waitFor();
  await area
    .getByRole('checkbox', { name: /选择分享题集/ })
    .first()
    .check();
  await area
    .getByRole('navigation', { name: '可分享题集分页', exact: true })
    .getByRole('button', { name: '下一页', exact: false })
    .click();
  await area
    .getByRole('checkbox', { name: /选择分享题集/ })
    .first()
    .check();
  await area.getByRole('button', { name: '分享已选 2 份', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '分享内容', exact: true });
  await dialog.getByText('导出规模检查通过', { exact: true }).waitFor();
  let file = await downloaded(
    dialog.getByRole('button', { name: '导出完整分享数据包（ZIP）', exact: true }),
  );
  assert.equal(file.payloads[0].data.papers.length, 2);
  assert.equal(file.payloads[0].data.questions.length, 1);
  assert.equal(await dialog.getByRole('button', { name: '导出分享PDF', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await area.getByRole('button', { name: '分享全部筛选结果 26 份', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '分享内容', exact: true });
  await dialog.getByText('导出规模检查通过', { exact: true }).waitFor();
  file = await downloaded(
    dialog.getByRole('button', { name: '导出完整分享数据包（ZIP）', exact: true }),
  );
  assert.equal(file.payloads[0].data.papers.length, 26);
  assert.ok(file.payloads[0].data.papers.every((p) => p.title.startsWith('批量分享卷')));
  await page.keyboard.press('Escape');
  checks.push('题集筛选、跨页勾选及全部筛选批量导出不截断为当前页，公共题目只存一份');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      width + 'px横向溢出',
    );
    await page.screenshot({ path: join(h.folder, 'sharing-' + width + '.png'), fullPage: true });
  }
  h.assertClean();
  await writeFile(
    join(h.folder, 'report.json'),
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
