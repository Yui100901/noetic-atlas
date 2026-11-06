/** Real full/domain SQLite downloads in a disposable installation. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataPackage, SQLITE_PACKAGE_LIMITS } from '../../shared/packages/data-package.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'sqlite-migration-ui',
  setup: `
const api=async(url,method='GET',payload)=>{const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<400,r.body);return r.json();};
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();seed.domains.push({id:'other-domain',name:'另一领域',description:'',sortOrder:1});seed.categories.push({id:'other-category',domainId:'other-domain',parentId:null,name:'其他分类',description:'',sortOrder:0});
seed.questions.push(fixtureQuestion('MIXED-QUESTION','true_false',{categoryIds:['other-category'],tagIds:[]}),fixtureQuestion('UNRELATED-QUESTION','true_false',{categoryIds:['other-category'],tagIds:[],stemMarkdown:'UNRELATED_MIGRATION_SENTINEL_829164'}));
await api('/api/import','POST',{mode:'merge',data:seed});
const mixed=await api('/api/papers','POST',{title:'跨领域题集',mode:'manual',questionIds:['FIXTURE-BOOL','MIXED-QUESTION'],scoring:{enabled:false}});
const attempt=await api('/api/papers/'+mixed.id+'/attempts','POST',{});await api('/api/attempts/'+attempt.id+'/submit','POST',{answers:{'FIXTURE-BOOL':{value:'false'},'MIXED-QUESTION':{value:'true'}}});
const other=await api('/api/papers','POST',{title:'无关题集',mode:'manual',questionIds:['UNRELATED-QUESTION'],scoring:{enabled:false}});await api('/api/papers/'+other.id+'/attempts','POST',{});
return {total:8,selected:7,mixedId:mixed.id,attemptId:attempt.id};
`,
});
const { page, origin } = h,
  checks = [];
const area = page.getByRole('region', { name: 'SQLite 数据迁移', exact: true });
const preview = () => area.getByRole('button', { name: '预览迁移范围', exact: true });
const exportButton = () => area.getByRole('button', { name: '导出迁移文件', exact: true });
const download = async () => {
  const [result] = await Promise.all([page.waitForEvent('download'), exportButton().click()]);
  return {
    filename: result.suggestedFilename(),
    bytes: new Uint8Array(await readFile(await result.path())),
  };
};
const isSQLite = (bytes) =>
  assert.equal(new TextDecoder().decode(bytes.slice(0, 16)), 'SQLite format 3\0');
try {
  await page.goto(origin + '/#/settings?tab=backup');
  await area.waitFor();
  const tabs = page.getByRole('navigation', { name: '数据与迁移分类', exact: true });
  assert.deepEqual(await tabs.getByRole('link').allTextContents(), [
    '迁移',
    '数据健康',
    '清理数据',
    '重置学习进度',
  ]);
  assert.equal(await exportButton().isDisabled(), true);
  await preview().click();
  await area.getByText('整个学习站 · 迁移 8 道题目', { exact: true }).waitFor();
  const all = await download();
  const packet = await readDataPackage(all.bytes, SQLITE_PACKAGE_LIMITS);
  assert.equal(packet.manifest.kind, 'sqlite-backup');
  isSQLite(packet.files.get('database/migration.sqlite'));
  const metadata = JSON.parse(
    new TextDecoder().decode(packet.files.get('metadata/migration.json')),
  );
  assert.equal(metadata.counts.attempts, 2);
  assert.equal(metadata.counts.questions, 8);
  checks.push('设置只有一个迁移子页，整体ZIP实际下载SQLite及完整历史计数');
  await area.getByRole('radio', { name: '指定领域', exact: true }).check();
  assert.equal(await exportButton().isDisabled(), true);
  assert.equal(await preview().isDisabled(), true);
  await area.getByRole('checkbox', { name: '测试领域', exact: true }).check();
  await preview().click();
  await area.getByText('1 个领域 · 迁移 7 道题目', { exact: true }).waitFor();
  await area.getByRole('radio', { name: 'SQLite 数据库（.sqlite）', exact: true }).check();
  const domain = await download();
  assert.ok(domain.filename.endsWith('.sqlite'));
  isSQLite(domain.bytes);
  assert.ok(
    !new TextDecoder().decode(domain.bytes).includes('UNRELATED_MIGRATION_SENTINEL_829164'),
  );
  assert.ok(new TextDecoder().decode(domain.bytes).includes(h.state.attemptId));
  const source = await page.request.get(origin + '/api/export');
  assert.equal((await source.json()).questions.length, 8);
  checks.push('领域原始数据库保留跨领域整次作答和必要引用，排除无关题且源库未修改');
  const q = await page.request.post(origin + '/api/questions', {
    data: {
      id: 'NEW-MIGRATION-Q',
      type: 'true_false',
      title: '预览后新增',
      stemMarkdown: '预览变化检测',
      correctAnswers: ['true'],
    },
  });
  assert.ok(q.ok(), await q.text());
  await exportButton().click();
  await area
    .getByRole('alert')
    .filter({ hasText: /重新预览/ })
    .waitFor();
  assert.equal(await exportButton().isDisabled(), true);
  await area.getByRole('radio', { name: '整个学习站', exact: true }).check();
  await preview().click();
  await area.getByText('整个学习站 · 迁移 9 道题目', { exact: true }).waitFor();
  checks.push('源库变化阻止过期导出，并允许重新预览');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `${width}px横向溢出`,
    );
    await page.screenshot({ path: join(h.folder, `migration-${width}.png`), fullPage: true });
  }
  checks.push('迁移范围、统计和操作在320/390/1440px布局正常');
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
