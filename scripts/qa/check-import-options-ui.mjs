import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDataPackage } from '../../shared/packages/data-package.ts';
import { questionSchema } from '../../server/core/validation.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'import-options-ui',
  setup: `
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,response.body);return response.json();};
await api('/api/domains','POST',{id:'biology',name:'生物学'});await api('/api/domains','POST',{id:'computer',name:'计算机'});
await api('/api/categories','POST',{id:'cell',domainId:'biology',name:'细胞生物学'});await api('/api/categories','POST',{id:'java',domainId:'computer',name:'Java'});
await api('/api/tags','POST',{id:'basic',name:'基础',domainId:'biology',kind:'topic'});await api('/api/tags','POST',{id:'computer-tag',name:'并发',domainId:'computer',kind:'topic'});
const q=await api('/api/questions','POST',{id:'local-cell',title:'细胞的基本单位',type:'short_answer',stemMarkdown:'细胞为什么是生物体结构和功能的基本单位？',answerMarkdown:'细胞具有独立的生命活动基本结构。',categoryIds:['cell'],tagIds:['basic']});
await api('/api/questions/review','POST',{ids:[q.id],action:'approve',confirmed:true,expectedUpdatedAt:{[q.id]:q.updatedAt}});
`,
});
const { page, origin } = h,
  checks = [];
const stamp = '2026-11-06T00:00:00.000Z';
const original = questionSchema.parse({
  id: 'remote-cell-question',
  title: '细胞的基本单位',
  type: 'short_answer',
  stemMarkdown: '细胞为什么是生物体结构和功能的基本单位？',
  answerMarkdown: '细胞具有独立的生命活动基本结构。',
  categoryIds: ['remote-cell'],
  tagIds: ['remote-basic'],
});
const source = {
  domains: [{ id: 'remote-bio', name: '生物', description: '', sortOrder: 0 }],
  categories: [
    {
      id: 'remote-cell',
      name: '细胞',
      description: '',
      sortOrder: 0,
      domainId: 'remote-bio',
      parentId: null,
    },
  ],
  tags: [
    {
      id: 'remote-basic',
      name: '入门',
      description: '',
      color: '#123456',
      domainId: 'remote-bio',
      kind: 'topic',
    },
  ],
};
async function packet(question) {
  return Buffer.from(
    await buildDataPackage({
      kind: 'share',
      title: '映射验收包',
      payloads: [
        {
          path: 'data/questions.json',
          data: {
            format: 'learning-share',
            schemaVersion: 1,
            exportedAt: stamp,
            title: '映射验收包',
            ...source,
            assets: [],
            papers: [],
            questionBanks: [],
            questions: [question],
          },
        },
      ],
    }),
  );
}
async function load(question) {
  await page.getByLabel('选择 ZIP 数据包', { exact: true }).setInputFiles({
    name: 'source.zip',
    mimeType: 'application/zip',
    buffer: await packet(question),
  });
  await page.getByRole('heading', { name: '映射验收包', exact: true }).waitFor();
}
async function api(path) {
  const r = await page.request.get(origin + path);
  assert.ok(r.ok(), await r.text());
  return r.json();
}
const commit = () => page.getByRole('button', { name: '确认导入整个数据包', exact: true });
const row = (kind, id) => page.locator(`[data-source-taxonomy="${kind}:${id}"]`);
const selectMode = (kind, id, field, mode) =>
  row(kind, id)
    .getByLabel(field + '处理方式', { exact: true })
    .selectOption(mode);
async function openMapping() {
  const detail = page.locator('.import-taxonomy-mapping');
  if (!(await detail.evaluate((element) => element.open))) await detail.locator('summary').click();
}
async function recheck() {
  await page.getByRole('button', { name: '重新预览数据包', exact: true }).click();
  await page.getByRole('heading', { name: '映射验收包', exact: true }).waitFor();
}
async function apply() {
  const keepBoth = page.getByRole('button', { name: '未处理项全部保留两者', exact: true });
  if (await keepBoth.count()) await keepBoth.click();
  await commit().click();
  await page.getByText('数据包已完整导入。', { exact: false }).waitFor();
}
try {
  await page.goto(origin + '/#/sharing');
  await page.getByText('选择哪种导入方式？', { exact: true }).click();
  await page.getByRole('link', { name: '数据包格式与导入说明', exact: true }).click();
  await page.getByRole('heading', { name: '数据包格式', exact: true }).waitFor();
  assert.match(await page.locator('.handbook-content').innerText(), /manifest.json/);
  checks.push('当前数据包格式说明在应用内离线可读，包含根清单约定');
  await page.goto(origin + '/#/sharing');
  const toggle = page.getByRole('checkbox', { name: '导入前查重', exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), true);
  await load({ ...original, answerMarkdown: '细胞是生命结构与功能活动的基本单位。' });
  await openMapping();
  await selectMode('domains', 'remote-bio', '领域 生物', 'target');
  assert.equal(await commit().count(), 0, 'changing source choices invalidates the whole preview');
  await row('domains', 'remote-bio')
    .getByLabel('领域 生物本地目标', { exact: true })
    .selectOption('biology');
  await page.getByRole('tab', { name: /^分类/ }).click();
  await selectMode('categories', 'remote-cell', '分类 细胞', 'target');
  const categoryTargets = row('categories', 'remote-cell').getByLabel('分类 细胞本地目标', {
    exact: true,
  });
  assert.equal(await categoryTargets.locator('option[value=java]').count(), 0);
  await categoryTargets.selectOption('cell');
  await page.getByRole('tab', { name: /^标签/ }).click();
  await selectMode('tags', 'remote-basic', '标签 入门', 'target');
  const tagTargets = row('tags', 'remote-basic').getByLabel('标签 入门本地目标', { exact: true });
  assert.equal(await tagTargets.locator('option[value="computer-tag"]').count(), 0);
  await tagTargets.selectOption('basic');
  await recheck();
  await page.getByRole('button', { name: '保留两者', exact: true }).waitFor();
  await apply();
  const imported = await api('/api/questions/remote-cell-question');
  assert.deepEqual(imported.categoryIds, ['cell']);
  assert.deepEqual(imported.tagIds, ['basic']);
  const taxonomy = await api('/api/taxonomy');
  assert.equal(
    taxonomy.domains.some((item) => item.id === 'remote-bio'),
    false,
  );
  assert.equal(
    taxonomy.categories.some((item) => item.id === 'remote-cell'),
    false,
  );
  assert.equal(
    taxonomy.tags.some((item) => item.id === 'remote-basic'),
    false,
  );
  checks.push(
    '生物映射生物学、分类和标签映射本地，错误领域目标不出现；修改使旧预览失效，确认后不创建孤立归类',
  );

  // The opt-out is selectable before the package is read, so users who know
  // the source is new can avoid the first content scan too.
  await toggle.uncheck();
  await load({ ...original, id: 'unchecked-copy' });
  assert.equal(await page.getByRole('heading', { name: '题目查重', exact: true }).count(), 0);
  await apply();
  assert.equal((await api('/api/questions?status=all')).total, 3);
  assert.equal((await api('/api/questions/unchecked-copy')).status, 'pending');
  checks.push('默认开启查重；读取前关闭可直接确认，不合并完全相同内容，新增仍待审核');

  await toggle.check();
  await load({
    ...original,
    id: 'renamed-question',
    title: '实验观察中的细胞结构',
    stemMarkdown: '说明显微观察到的细胞膜与细胞核结构。',
    answerMarkdown: '按观察结果描述细胞膜和细胞核。',
  });
  await openMapping();
  await page.getByRole('tab', { name: /^领域/ }).click();
  await selectMode('domains', 'remote-bio', '领域 生物', 'rename');
  await row('domains', 'remote-bio')
    .getByLabel('领域 生物导入名称', { exact: true })
    .fill('实验生物学');
  await page.getByRole('tab', { name: /^分类/ }).click();
  await selectMode('categories', 'remote-cell', '分类 细胞', 'rename');
  await row('categories', 'remote-cell')
    .getByLabel('分类 细胞导入名称', { exact: true })
    .fill('实验基础');
  await page.getByRole('tab', { name: /^标签/ }).click();
  await selectMode('tags', 'remote-basic', '标签 入门', 'rename');
  await row('tags', 'remote-basic')
    .getByLabel('标签 入门导入名称', { exact: true })
    .fill('观察方法');
  await recheck();
  await apply();
  const renamed = await api('/api/questions/renamed-question'),
    after = await api('/api/taxonomy');
  const category = after.categories.find((item) => item.id === renamed.categoryIds[0]);
  assert.equal(category.name, '实验基础');
  assert.equal(after.domains.find((item) => item.id === category.domainId).name, '实验生物学');
  assert.equal(after.tags.find((item) => item.id === renamed.tagIds[0]).name, '观察方法');
  checks.push('领域、分类、标签可使用新名称导入，并保持新的领域依赖');

  await load({ ...original, id: 'pending-preview' });
  await toggle.uncheck();
  assert.equal(await commit().count(), 0);
  await recheck();
  await toggle.check();
  assert.equal(await commit().count(), 0);
  await recheck();
  checks.push('反复切换查重都会废弃原指纹和决策，重新预览后才允许提交');
  await openMapping();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
      `${width}px layout`,
    );
    await page.screenshot({ path: join(h.folder, `mapping-${width}.png`), fullPage: true });
  }
  const sqlitePackage = await buildDataPackage({
    kind: 'sqlite-backup',
    title: '迁移入口验收包',
    payloads: [],
    files: [
      {
        path: 'database/backup.sqlite',
        bytes: Buffer.from('SQLite format 3 mock'),
        mediaType: 'application/vnd.sqlite3',
      },
    ],
  });
  await page.getByLabel('选择 ZIP 数据包', { exact: true }).setInputFiles({
    name: 'migration.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(sqlitePackage),
  });
  const migrationLink = page.getByRole('link', { name: '前往 SQLite 迁移', exact: true });
  await migrationLink.waitFor();
  assert.equal(await migrationLink.getAttribute('href'), '#/settings?tab=backup&sub=migration');
  assert.equal(await commit().count(), 0);
  checks.push('SQLite备份不会上传为内容，明确指向统一迁移入口');
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
