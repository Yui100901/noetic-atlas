import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildDataPackage,
  readDataPackage,
  SQLITE_PACKAGE_LIMITS,
} from '../../shared/packages/data-package.ts';
import { fixtureQuestion } from '../../tests/fixtures/learning-seed.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'background-tasks-ui',
  backgroundTasks: true,
  setup: String.raw`
const { createServer } = await import('node:http');
const { fixtureQuestion, learningSeed } = await import('./tests/fixtures/learning-seed.ts');
const seed = learningSeed();
seed.questions = [fixtureQuestion('TASK-TF','true_false'), fixtureQuestion('TASK-SA','short_answer')];
let calls = 0;
const pending = new Map();
app.get('/__qa/provider', () => ({ calls, waiting:[...pending.keys()] }));
app.post('/__qa/provider/:id/release', request => {
  const release = pending.get(Number(request.params.id));
  release?.();
  return { released:!!release,calls };
});
const provider = createServer(async (req,res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const material = JSON.parse(body.messages[1].content).untrustedMaterial;
    assert.equal(material.selectionCount || material.requestedCount,2);
    const id = ++calls;
    const result = {
      title:'后台验收题集2题',
      description:'基于隔离题库的后台组题结果。',
      items:material.candidates.slice(0,2).map(question=>({questionId:question.id,reason:'在当前题库范围内'})),
    };
    const content = JSON.stringify(result);
    const cut = content.indexOf(',"description"');
    const frame = (delta,finish_reason=null) => 'data: '+JSON.stringify({choices:[{delta,finish_reason}]})+'\n\n';
    const gate = new Promise(done => {
      const release = () => { pending.delete(id); done(); };
      pending.set(id,release);
      res.once('close',release);
    });
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.write(frame({content:content.slice(0,cut),reasoning_content:'QA_PRIVATE_REASONING'}));
    await gate;
    if (!res.destroyed) res.end(frame({content:content.slice(cut)},'stop')+'data: [DONE]\n\n');
  } catch {
    if (!res.headersSent) res.writeHead(500,{'Content-Type':'application/json'});
    res.end('{}');
  }
});
await new Promise(done=>provider.listen(0,'127.0.0.1',done));
const imported = await app.inject({ url:'/api/import', method:'POST', payload:{ mode:'merge',data:seed } });
assert.equal(imported.statusCode,200,imported.body);
const settings = await app.inject({url:'/api/ai/settings',method:'PUT',payload:{
  enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'background-fixture',key:'fixture-only',
  supportsImages:false,sendImages:false,timeoutSeconds:90,maxTokens:8192,
}});
assert.equal(settings.statusCode,200,settings.body);
return {};
`,
});
const { page, origin } = h;
const checks = [];
const cancelRequests = [];
await page.addInitScript(() => {
  window.__taskNavigation = [];
  const replace = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    window.__taskNavigation.push({
      event: 'replace',
      from: location.hash,
      to: args[2],
      stack: new Error().stack,
    });
    return replace(...args);
  };
  addEventListener('hashchange', (event) =>
    window.__taskNavigation.push({
      event: 'hashchange',
      from: event.oldURL,
      to: event.newURL,
      current: location.hash,
    }),
  );
});
page.on('request', (request) => {
  const { pathname } = new URL(request.url());
  if (request.method() === 'POST' && /\/api\/tasks\/[^/]+\/cancel$/.test(pathname))
    cancelRequests.push(pathname);
});
const taskCenter = page.getByRole('link', { name: '后台任务与通知', exact: true });
const taskList = page.getByRole('region', { name: '后台任务列表', exact: true });
const taskCard = (title) => taskList.getByRole('article', { name: title, exact: true });
const button = (name) => page.getByRole('button', { name, exact: true });
const draftChoice = page.getByRole('dialog', { name: '继续AI辅助草稿', exact: true });

async function api(path, method = 'GET') {
  const response = await page.request.fetch(origin + path, { method });
  assert.ok(response.ok(), `${path}: ${response.status()}`);
  return response.json();
}

async function until(label, check) {
  const deadline = Date.now() + 35_000;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `未等到${label}`);
    await delay(100);
  }
}

function waitForProvider(id) {
  return until(`第 ${id} 次模型调用`, async () =>
    (await api('/__qa/provider')).waiting.includes(id),
  );
}

async function configurePaper(prompt) {
  await page.getByLabel('AI组题要求', { exact: true }).fill(prompt);
  await page.getByLabel('手动指定题量', { exact: true }).check();
  await page.getByLabel('推荐题量（组合题整组计）', { exact: true }).fill('2');
  await button('生成推荐组题预览').click();
}

try {
  await page.goto(origin + '/#/papers/new/ai');
  await taskCenter.waitFor();
  const originalPrompt = '生成2道知识基础练习题';
  await configurePaper(originalPrompt);
  await waitForProvider(1);
  const first = (await api('/api/tasks'))[0];
  assert.equal(first.operation, '/api/ai/paper-plan');
  assert.equal(first.status, 'running');
  assert.equal(Object.hasOwn(first, 'previewText'), false);
  const preview = page.getByLabel('AI生成中预览', { exact: true });
  await preview.getByText('后台验收题集2题', { exact: true }).waitFor();
  assert.doesNotMatch(await preview.innerText(), /QA_PRIVATE_REASONING/);
  checks.push('后台任务保留模型结果预览，任务列表与预览都不暴露推理字段');
  // Navigate again during the question list's DOM commit, before its passive
  // URL-normalization effect. That stale effect must not overwrite #/tasks.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (
        location.hash !== '#/questions' ||
        ![...document.querySelectorAll('h1')].some((heading) =>
          heading.textContent.includes('把知识，积累成自己的能力。'),
        )
      )
        return;
      observer.disconnect();
      document.querySelector('a[aria-label="后台任务与通知"]').click();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: /知识题库/ })
    .click();
  await taskList.waitFor();
  await page.waitForURL(/#\/tasks$/);
  assert.equal((await api('/api/tasks/' + first.id)).status, 'running');
  checks.push('题库提交期间快速进入后台任务，不会被旧页面的筛选 URL 规范化覆盖');
  const recommendation = taskCard('AI推荐题集');
  await recommendation.getByRole('button', { name: '取消任务', exact: true }).waitFor();
  assert.deepEqual(await api('/__qa/provider/1/release', 'POST'), { released: true, calls: 1 });
  await recommendation.getByText('已完成', { exact: true }).waitFor();
  await page.getByRole('status').filter({ hasText: 'AI推荐题集' }).first().waitFor();
  await recommendation.getByRole('button', { name: '查看结果', exact: true }).click();
  await recommendation.getByText('后台验收题集2题', { exact: true }).waitFor();
  await recommendation.getByRole('link', { name: '返回原功能', exact: true }).click();
  await page.waitForURL(/#\/papers\/new\/ai\?backgroundTask=task-/);
  await draftChoice.getByRole('button', { name: '继续此草稿', exact: true }).click();
  await button('确认创建题集').waitFor();
  assert.equal(await page.getByLabel('AI组题要求', { exact: true }).inputValue(), originalPrompt);
  assert.equal(await page.locator('.ai-plan-selection>li').count(), 2);
  await button('确认创建题集').click();
  await page.waitForURL(/#\/papers\/paper-/);
  const paperUrl = page.url();
  const paperId = paperUrl.split('/').at(-1);
  assert.equal((await api('/api/papers/' + paperId)).questions.length, 2);
  checks.push('真实 worker 在主导航切换后继续，完成有通知，返回草稿可恢复并正式创建题集');

  await page.goto(origin + '/#/papers/new/ai');
  await configurePaper('再次推荐2道知识基础练习题');
  await waitForProvider(2);
  await taskCenter.click();
  await taskList.waitFor();
  const second = (await api('/api/tasks'))[0];
  assert.notEqual(first.id, second.id);
  const newestRecommendation = taskCard('AI推荐题集').first();
  await newestRecommendation.getByRole('button', { name: '取消任务', exact: true }).click();
  await newestRecommendation.getByText('已取消', { exact: true }).waitFor();
  assert.equal((await api('/api/tasks/' + second.id)).status, 'cancelled');
  await newestRecommendation.getByRole('button', { name: '重试', exact: true }).click();
  await waitForProvider(3);
  assert.deepEqual(await api('/__qa/provider/3/release', 'POST'), { released: true, calls: 3 });
  await newestRecommendation.getByText('已完成', { exact: true }).waitFor();
  assert.equal((await api('/api/tasks/' + second.id)).attempt, 2);
  checks.push('任务中心取消执行，沿原任务重试，重新获得已校验结果');

  await page.goto(paperUrl);
  await taskCenter.waitFor();
  await button('分享').click();
  const share = page.getByRole('dialog', { name: '分享题集', exact: true });
  await share.getByRole('radio', { name: '题集数据包（ZIP）', exact: true }).check();
  await share.getByRole('button', { name: '下载文件', exact: true }).click();
  await until('分享包后台生成完成', async () =>
    (await api('/api/tasks')).some(
      (task) => task.operation === '/api/packages/export' && task.status === 'completed',
    ),
  );
  await share.getByRole('button', { name: '取消', exact: true }).click();
  await taskCenter.click();
  const exportTask = taskCard('生成导出文件');
  await exportTask.getByRole('button', { name: '查看结果', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await exportTask.getByRole('button', { name: '下载文件', exact: true }).click();
  const download = await downloadEvent;
  assert.match(download.suggestedFilename(), /\.zip$/i);
  const packet = await readDataPackage(await readFile(await download.path()));
  assert.equal(packet.manifest.kind, 'share');
  assert.ok(packet.manifest.files.length > 0);
  checks.push('普通题集分享生成后台 ZIP，任务中心下载的数据包可重新解析');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 840 });
    await exportTask.scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: resolve(h.folder, `tasks-${width}.png`), fullPage: true });
  }
  checks.push('任务列表、结果、按钮和顶部通知在 390/320 像素布局无横向溢出');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const importedQuestion = fixtureQuestion('TASK-IMPORTED', 'short_answer', {
    title: '低轨卫星通信',
    stemMarkdown: '低轨道卫星为什么可以降低信号传播时延？',
    answerMarkdown: '卫星轨道较低，信号往返经过的路径更短。',
  });
  const sharedData = packet.payloads[0].data;
  const incoming = await buildDataPackage({
    kind: 'share',
    title: '后台导入验收',
    payloads: [
      {
        path: 'data/questions.json',
        data: { ...sharedData, papers: [], questions: [...sharedData.questions, importedQuestion] },
      },
    ],
  });
  const detachedImport = page.getByRole('link', {
    name: '已交给后台，可切换页面或查看任务',
    exact: true,
  });
  await page.goto(origin + '/#/sharing?tab=package');
  await page.getByLabel('选择 ZIP 数据包', { exact: true }).setInputFiles({
    name: 'background-import.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(incoming),
  });
  await detachedImport.waitFor();
  const libraryLink = page.getByRole('navigation', { name: '主导航' }).getByRole('link', {
    name: /知识题库/,
  });
  await libraryLink.click();
  await page.waitForURL(/#\/questions$/);
  await taskCenter.click();
  const previewImport = taskCard('校验导入与查重');
  await previewImport.getByText('已完成', { exact: true }).waitFor({ timeout: 90_000 });
  await previewImport.getByRole('link', { name: '返回原功能', exact: true }).click();
  await page.waitForURL(/sharing\?tab=package&backgroundTask=task-/);
  await button('确认导入整个数据包').click();
  await detachedImport.waitFor();
  await libraryLink.click();
  await page.waitForURL(/#\/questions$/);
  await taskCenter.click();
  const confirmedImport = taskCard('导入数据包或题目');
  await confirmedImport.getByText('已完成', { exact: true }).waitFor({ timeout: 90_000 });
  await confirmedImport.getByRole('link', { name: '返回原功能', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: /数据包已完整导入/ })
    .waitFor();
  const afterImport = await api('/api/export');
  assert.equal(afterImport.questions.length, 3);
  assert.equal(
    afterImport.questions.find((question) => question.id === importedQuestion.id)?.status,
    'pending',
  );
  checks.push('分享 ZIP 在切页后继续查重和导入，原功能可恢复预览，重复题复用且新题保留待审核');

  await page.goto(origin + '/#/settings?tab=backup&sub=migration');
  await page.getByRole('radio', { name: 'SQLite 迁移包（ZIP）', exact: true }).check();
  await button('预览迁移范围').click();
  await page.getByText('整个学习站 · 迁移 3 道题目', { exact: true }).waitFor({ timeout: 90_000 });
  await button('导出迁移文件').click();
  await until('SQLite迁移已排队', async () =>
    (await api('/api/tasks')).some((task) =>
      task.operation.startsWith('/api/migrations/database?'),
    ),
  );
  await taskCenter.click();
  const migrations = taskCard('SQLite数据迁移');
  const binaryExport = migrations.first();
  await binaryExport.getByText('已完成', { exact: true }).waitFor({ timeout: 90_000 });
  await binaryExport.getByRole('button', { name: '查看结果', exact: true }).click();
  const migrationTask = (await api('/api/tasks')).find((task) =>
    task.operation.startsWith('/api/migrations/database?'),
  );
  const result = await api('/api/tasks/' + migrationTask.id + '/result');
  assert.ok(result.binaryByteLength > 0);
  assert.equal(Object.hasOwn(result, 'binaryBase64'), false);
  const migrationDownloadEvent = page.waitForEvent('download', {
    predicate: (file) => file.url() === origin + '/api/tasks/' + migrationTask.id + '/download',
  });
  await binaryExport.getByRole('button', { name: '下载文件', exact: true }).click();
  const migrationDownload = await migrationDownloadEvent;
  const migrationBytes = await readFile(await migrationDownload.path());
  assert.equal(migrationBytes.length, result.binaryByteLength);
  const migration = await readDataPackage(migrationBytes, SQLITE_PACKAGE_LIMITS);
  assert.equal(migration.manifest.kind, 'sqlite-backup');
  const database = migration.files.get('database/migration.sqlite');
  assert.ok(database);
  const sqlite = Buffer.from(database);
  assert.equal(sqlite.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(
    sqlite.includes('background_task:'),
    false,
    'portable SQLite contains task receipts',
  );
  checks.push('普通迁移入口后台生成 SQLite ZIP，任务中心下载独立二进制，迁移库不含本地任务回执');

  h.assertClean();
  const report = {
    passed: checks.length,
    checks,
    providerCalls: (await api('/__qa/provider')).calls,
  };
  await writeFile(resolve(h.folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await h.captureFailure(error, {
    checks,
    cancelRequests,
    navigation: await page.evaluate(() => window.__taskNavigation).catch(() => undefined),
    provider: await api('/__qa/provider').catch(() => undefined),
    tasks: await api('/api/tasks').catch(() => undefined),
  });
  throw error;
} finally {
  await h.close();
}
