/** Real domain migration/share downloads, clean receivers and bounded stale-response checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'domain-export-ui',
  setup: String.raw`
app.post('/__qa/check-export-import',async request=>{
 const receiver=await buildApp({databasePath:':memory:',seedPath:'test-results/domain-export-ui/no-receiver-seed',staticRoot:'test-results/domain-export-ui/no-receiver-web',dailyPushScheduler:false,logger:false});
 try{
  for(const data of request.body.files){
   if(data.format==='learning-share'){
    const inspect=await receiver.inject({method:'POST',url:'/api/sharing/preview',payload:{data}});assert.equal(inspect.statusCode,200,inspect.body);
    const imported=await receiver.inject({method:'POST',url:'/api/sharing/import',payload:{data,confirmed:true,expectedFingerprint:inspect.json().fingerprint}});assert.equal(imported.statusCode,200,imported.body);
   }else{
    const imported=await receiver.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
   }
  }
  const exported=await receiver.inject('/api/export');assert.equal(exported.statusCode,200,exported.body);
  const data=exported.json();return {questions:data.questions.map(({id,status,collection})=>({id,status,collection})),domains:data.domains.length,categories:data.categories.length,tags:data.tags.length,assets:data.assets.length};
 }finally{await receiver.close();}
});
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed({includeNonPublic:true});
seed.domains.push({id:'fixture-language',name:'测试语言学',description:'',sortOrder:1},{id:'fixture-empty',name:'空领域',description:'',sortOrder:2});
seed.categories.push({id:'fixture-language-basic',domainId:'fixture-language',parentId:null,name:'语言基础',description:'',sortOrder:0});
seed.tags.push({id:'fixture-language-tag',name:'语言概念',color:'#123456',description:'',domainId:'fixture-language',kind:'topic'});
seed.questions.find(value=>value.id==='FIXTURE-SHORT-1').categoryIds.push('fixture-language-basic');
seed.questions.push(fixtureQuestion('FIXTURE-LANGUAGE','true_false',{categoryIds:['fixture-language-basic'],tagIds:['fixture-language-tag']}));
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
seed.assets=[{id:'fixture-export-image',filename:'示意图.png',mimeType:'image/png',dataBase64:png,sizeBytes:Buffer.from(png,'base64').length,width:1,height:1,createdAt:'2026-10-21T00:00:00.000Z'}];
seed.questions[0].stemMarkdown+='\n\n![示意图](/api/assets/fixture-export-image/content)';
const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:seed}});assert.equal(imported.statusCode,200,imported.body);
return {singleCount:8,combinedCount:9,shareCount:7};
`,
});
const { page, origin } = h,
  checks = [];
const ui = page.locator('.domain-export');
const field = (name) => ui.getByLabel(name, { exact: true });
const preview = () => ui.getByRole('button', { name: '预览导出内容', exact: true });
const download = () => ui.getByRole('button', { name: /^生成并下载/ });
const questionCount = () => ui.locator('.domain-export-metrics > div').first().locator('strong');
const selectDomain = (name, checked = true) =>
  ui
    .locator('.domain-export-domain')
    .filter({ has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
    .locator('input')
    .setChecked(checked);
async function inspect() {
  await preview().click();
  await ui.getByRole('region', { name: '导出预览', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.domain-export[aria-busy="true"]'));
}
async function takeDownload() {
  const [file] = await Promise.all([page.waitForEvent('download'), download().click()]);
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}
async function importIntoCleanReceiver(files) {
  const response = await page.request.post(origin + '/__qa/check-export-import', {
    data: { files },
  });
  assert.ok(response.ok(), await response.text());
  return response.json();
}
function verifyPrivateExclusion(data) {
  for (const key of [
    'settings',
    'studyRecords',
    'studyStates',
    'attempts',
    'questionAttempts',
    'questionDrafts',
    'questionRevisions',
    'aiSettings',
  ])
    assert.equal(Object.hasOwn(data, key), false, `Unexpected private key ${key}`);
}
function unzipStored(buffer) {
  const files = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, 'Expected portable stored ZIP');
    const size = buffer.readUInt32LE(offset + 18),
      nameLength = buffer.readUInt16LE(offset + 26),
      extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    assert.ok(!files.has(name) && !name.includes('..') && !name.startsWith('/'));
    files.set(name, buffer.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
  return files;
}
try {
  await page.goto(origin + '/#/settings?tab=backup&sub=content');
  await ui.getByRole('heading', { name: '按领域导出题库', exact: true }).waitFor();
  await ui.getByText('正在统计各领域题量…', { exact: true }).waitFor({ state: 'hidden' });
  assert.ok(await ui.getByRole('radio', { name: /迁移题库/ }).isChecked());
  assert.match(
    await ui.locator('.domain-export-scope').innerText(),
    /所有审核状态.*通用与个人专项/s,
  );
  assert.ok(await download().isDisabled());
  assert.equal(await page.getByRole('heading', { name: '完整 JSON 备份', exact: true }).count(), 0);
  checks.push('内容迁移页聚焦领域导出；默认可信迁移保留审核/个人内容，预览前不可下载');

  await field('搜索导出领域').fill('语言');
  assert.equal(await ui.locator('.domain-export-domain').count(), 1);
  await selectDomain('测试语言学');
  await field('搜索导出领域').fill('');
  await selectDomain('测试领域');
  assert.match(await ui.locator('.domain-export-domain-heading').innerText(), /已选 2 个/);
  await selectDomain('测试语言学', false);
  await inspect();
  assert.equal(await questionCount().innerText(), String(h.state.singleCount));
  const singleDownload = await takeDownload(),
    single = JSON.parse(singleDownload.bytes.toString('utf8'));
  assert.match(singleDownload.name, /\.json$/);
  verifyPrivateExclusion(single);
  assert.equal(single.questions.length, h.state.singleCount);
  assert.equal(single.assets.length, 1);
  const singleImported = await importIntoCleanReceiver([single]);
  assert.equal(singleImported.questions.length, h.state.singleCount);
  assert.equal(singleImported.questions.find((q) => q.id === 'FIXTURE-PENDING').status, 'pending');
  assert.equal(
    singleImported.questions.find((q) => q.id === 'FIXTURE-PERSONAL').collection,
    'personal',
  );
  assert.equal(singleImported.assets, 1);
  checks.push('可搜索单/多选并保留选择；单领域JSON真实导入空库，保留原审核/个人属性和图片');

  await selectDomain('测试语言学');
  assert.equal(await ui.getByRole('region', { name: '导出预览' }).count(), 0);
  assert.ok(await download().isDisabled());
  await inspect();
  assert.equal(await questionCount().innerText(), String(h.state.combinedCount));
  assert.match(
    await ui.getByRole('region', { name: '导出预览' }).innerText(),
    /1 次跨领域重复归属/,
  );
  const combined = JSON.parse((await takeDownload()).bytes.toString('utf8'));
  assert.equal(new Set(combined.questions.map((q) => q.id)).size, h.state.combinedCount);
  assert.equal((await importIntoCleanReceiver([combined])).questions.length, h.state.combinedCount);
  checks.push('多领域合并去重、显示分类标签依赖及跨域重复，修改选择立即使旧预览失效');

  await ui.getByRole('button', { name: '全选领域', exact: true }).click();
  await ui.getByRole('radio', { name: /按领域分别导出/ }).check();
  await inspect();
  assert.match(
    await ui.getByRole('region', { name: '导出预览' }).innerText(),
    /1 个在当前范围内没有题目/,
  );
  const zipDownload = await takeDownload(),
    entries = unzipStored(zipDownload.bytes);
  assert.match(zipDownload.name, /\.zip$/);
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  assert.deepEqual(manifest.emptyDomainIds, ['fixture-empty']);
  assert.equal(manifest.files.length, 2);
  assert.ok(entries.has('README.md'));
  const packages = manifest.files.map((part) => {
    const bytes = entries.get(part.filename);
    assert.equal(bytes.length, part.byteLength);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256);
    const data = JSON.parse(bytes.toString('utf8'));
    verifyPrivateExclusion(data);
    return data;
  });
  const zipImported = await importIntoCleanReceiver(packages);
  assert.equal(zipImported.questions.length, h.state.combinedCount);
  assert.equal(zipImported.assets, 1);
  checks.push(
    '按领域ZIP实际包含独立可导入JSON与完整依赖、清单SHA256；跳过空领域，合并导入复用跨域题',
  );

  await ui.getByRole('radio', { name: /分享题库/ }).check();
  assert.match(await ui.locator('.domain-export-scope').innerText(), /已通过审核.*仅通用题目/s);
  assert.match(await ui.locator('.domain-export-domain-heading').innerText(), /已选 3 个/);
  await ui.getByRole('radio', { name: /合并为一个 JSON/ }).check();
  await inspect();
  assert.equal(await questionCount().innerText(), String(h.state.shareCount));
  const share = JSON.parse((await takeDownload()).bytes.toString('utf8'));
  assert.equal(share.format, 'learning-share');
  assert.ok(share.questions.every((q) => q.status === 'pending' && q.collection === 'general'));
  const shareImported = await importIntoCleanReceiver([share]);
  assert.equal(shareImported.questions.length, h.state.shareCount);
  assert.ok(shareImported.questions.every((q) => q.status === 'pending'));
  checks.push('分享用途恢复published/general默认范围、保留领域选择；真实分享导入全部待审');

  await ui.getByRole('button', { name: '清空选择', exact: true }).click();
  await selectDomain('空领域');
  await inspect();
  assert.equal(await questionCount().innerText(), '0');
  assert.ok(await download().isDisabled());
  checks.push('仅空领域可预览说明，禁止生成空导出包');

  await selectDomain('空领域', false);
  await selectDomain('测试领域');
  let failure = true;
  const previewPath = '**/api/content-exports/preview';
  const failRoute = async (route) => {
    if (failure && route.request().postDataJSON().domainIds.length) {
      failure = false;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'QA_PREVIEW_ERROR', message: '测试预览暂时不可用' },
        }),
      });
    }
    return route.continue();
  };
  await page.route(previewPath, failRoute);
  await preview().click();
  await ui.getByRole('alert').filter({ hasText: '测试预览暂时不可用' }).waitFor();
  assert.match(await ui.locator('.domain-export-domain-heading').innerText(), /已选 1 个/);
  await page.unroute(previewPath, failRoute);
  await inspect();
  checks.push('预览失败显示具体原因并保留选择，可原位重试');

  let releasePreview, previewEntered, previewDone;
  const previewGate = new Promise((resolve) => {
    releasePreview = resolve;
  });
  const previewStarted = new Promise((resolve) => {
    previewEntered = resolve;
  });
  const previewHandled = new Promise((resolve) => {
    previewDone = resolve;
  });
  const latePreview = async (route) => {
    if (!route.request().postDataJSON().domainIds.length) return route.continue();
    previewEntered();
    try {
      const response = await route.fetch();
      await previewGate;
      await route.fulfill({ response });
    } catch {
    } finally {
      previewDone();
    }
  };
  await page.route(previewPath, latePreview);
  await preview().click();
  await previewStarted;
  await selectDomain('空领域');
  releasePreview();
  await previewHandled;
  assert.ok(await download().isDisabled());
  assert.equal(await ui.getByRole('region', { name: '导出预览' }).count(), 0);
  await page.unroute(previewPath, latePreview);
  checks.push('输入变化会取消旧预览；迟到响应不能恢复过期下载状态');

  await inspect();
  let releaseBuild,
    buildEntered,
    buildDone,
    unexpectedDownloads = 0;
  const buildGate = new Promise((resolve) => {
    releaseBuild = resolve;
  });
  const buildStarted = new Promise((resolve) => {
    buildEntered = resolve;
  });
  const buildHandled = new Promise((resolve) => {
    buildDone = resolve;
  });
  const countDownload = () => {
    unexpectedDownloads++;
  };
  const lateBuild = async (route) => {
    buildEntered();
    try {
      const response = await route.fetch();
      await buildGate;
      await route.fulfill({ response });
    } catch {
    } finally {
      buildDone();
    }
  };
  page.on('download', countDownload);
  await page.route('**/api/content-exports', lateBuild);
  await download().click();
  await buildStarted;
  await ui.getByRole('radio', { name: /按领域分别导出/ }).check();
  releaseBuild();
  await buildHandled;
  assert.ok(await download().isDisabled());
  await page.waitForTimeout(150);
  assert.equal(unexpectedDownloads, 0);
  await page.unroute('**/api/content-exports', lateBuild);
  page.off('download', countDownload);
  checks.push('生成期间更改文件组织使结果失效，迟到生成结果不会触发下载');

  await inspect();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await ui.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(h.folder, 'domain-export-mobile-dark.png') });
  await download().scrollIntoViewIfNeeded();
  const box = await download().boundingBox();
  assert.ok(box && box.width > 200 && box.x >= 0 && box.x + box.width <= 391);
  await page.screenshot({ path: resolve(h.folder, 'domain-export-actions-mobile-dark.png') });
  checks.push('390px暗色无横向溢出，领域选择及预览下载操作清晰可用');
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
