/** Shared configuration draft, stable category URLs and safe retention saves. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const setup = `const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,response.body);return response.json();};
const original=await api('/api/settings');await api('/api/settings','PUT',{settings:{...original,dailyPush:{...original.dailyPush,newPoints:21}}});
const q=await api('/api/questions','POST',{id:'SETTINGS-SAVE-Q',title:'隔离配置判断题',type:'true_false',stemMarkdown:'事务原子性保证整体提交或回滚。',correctAnswers:['true']});await api('/api/questions/review','POST',{ids:[q.id],action:'approve',confirmed:true,expectedUpdatedAt:{[q.id]:q.updatedAt}});
const paper=await api('/api/papers','POST',{id:'SETTINGS-SAVE-PAPER',title:'清理确认测试题集',mode:'manual',questionIds:[q.id],scoring:{enabled:false}});for(let index=0;index<3;index++)await api('/api/papers/'+paper.id+'/attempts','POST',{});
return {paperId:paper.id};`;
let harness,
  discardDialog = false;
const checks = [];
try {
  harness = await startBrowserHarness({
    name: 'settings-save-bar-ui',
    setup,
    onDialog: (dialog) => (discardDialog ? void dialog.dismiss() : void dialog.accept()),
  });
  const { page, origin, folder } = harness,
    { paperId } = harness.state;
  const api = async (path) => {
    const r = await page.request.get(origin + path);
    assert.ok(r.ok(), await r.text());
    return r.json();
  };
  const bar = () => page.getByRole('region', { name: '系统配置保存操作', exact: true });
  const save = () => bar().getByRole('button', { name: '保存系统配置', exact: true });
  const discard = () => bar().getByRole('button', { name: '放弃全部配置修改', exact: true });
  const tabs = () => page.getByRole('navigation', { name: '系统配置分区', exact: true });
  const tab = (name) => tabs().getByRole('link', { name, exact: false }).click();
  const sub = (name) =>
    page.locator('.settings-subtabs').getByRole('link', { name, exact: true }).click();
  const duration = () => page.getByLabel('考试模式默认时长（分钟）', { exact: true });
  const maxDraft = () => page.getByLabel('每题集最多草稿数', { exact: true });
  const clean = () => bar().getByText('系统配置已保存', { exact: true }).waitFor();
  const wait = async (fn, label) => {
    for (let i = 0; i < 150; i++) {
      if (await fn()) return;
      await delay(60);
    }
    assert.fail(label);
  };
  const barVisible = async () => {
    const box = await bar().boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= (await page.evaluate(() => innerHeight)) + 1,
      JSON.stringify(box),
    );
  };
  const capture = async (name) => {
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      'horizontal overflow',
    );
    await page.screenshot({ path: resolve(folder, name + '.png'), fullPage: true });
  };

  await page.goto(origin + '/#/settings');
  await save().waitFor();
  await barVisible();
  assert.equal(await tabs().getByRole('link').count(), 7);
  assert.equal(await page.getByRole('button', { name: '保存系统配置', exact: true }).count(), 1);
  assert.equal(await duration().isVisible(), false);
  await tab('练习与计分');
  await duration().fill('90');
  await bar()
    .getByText(/个分区有未保存修改/)
    .waitFor();
  assert.equal((await api('/api/settings')).examDurationMinutes, 120);
  await discard().click();
  assert.equal(await duration().inputValue(), '120');
  await clean();
  checks.push('七个用途分区只显示相关字段，一处系统保存入口，放弃修改恢复原基线而不写数据库');

  await duration().fill('90');
  await tab('复习与计划');
  await sub('每日推荐与计划');
  await page.getByLabel('新题目标分值', { exact: true }).fill('25');
  await tab('外观与通用');
  await page.locator('.theme-option-pink').click();
  await tab('练习与计分');
  assert.equal(await duration().inputValue(), '90');
  await save().click();
  await clean();
  let settings = await api('/api/settings');
  assert.equal(settings.examDurationMinutes, 90);
  assert.equal(settings.dailyPush.newPoints, 25);
  assert.equal(settings.theme, 'pink');
  checks.push('跨分区的主题、考试与每日计划共用一份草稿和版本，一次保存全部成功且没有旧快照覆盖');

  await tab('草稿与历史');
  await sub('学习草稿与作答');
  await maxDraft().fill('0');
  await tab('练习与计分');
  await save().click();
  await page.waitForURL(/tab=retention&sub=learning/);
  await maxDraft().waitFor();
  await wait(
    () => maxDraft().evaluate((input) => document.activeElement === input),
    'invalid hidden field focused',
  );
  assert.equal((await api('/api/settings')).maxDraftsPerPaper, 3);
  await maxDraft().fill('3');
  checks.push('其他分区有无效输入时保存会自动定位该分区并聚焦，不发送非法配置或尝试聚焦隐藏字段');

  await tab('练习与计分');
  await duration().fill('80');
  const failed = async (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 507,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'QA_SAVE_FAILURE', message: '专项：配置保存失败' },
          }),
        })
      : route.continue();
  await page.route('**/api/settings', failed);
  await save().click();
  await page.getByText('专项：配置保存失败', { exact: true }).waitFor();
  assert.equal(await duration().inputValue(), '80');
  assert.equal((await api('/api/settings')).examDurationMinutes, 90);
  await page.unroute('**/api/settings', failed);
  let release,
    seen = false;
  const gate = new Promise((done) => (release = done));
  const slow = async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    seen = true;
    await gate;
    return route.continue();
  };
  await page.route('**/api/settings', slow);
  await save().click();
  await wait(() => seen, 'save started');
  assert.equal(await duration().isDisabled(), true);
  await tab('外观与通用');
  assert.match(page.url(), /tab=practice/);
  release();
  await clean();
  await page.unroute('**/api/settings', slow);
  assert.equal(await duration().isDisabled(), false);
  checks.push('保存失败保留输入；保存中禁止修改与切换，成功后更新同一版本基线');

  await page.getByRole('button', { name: '填入练习与计分默认值', exact: true }).click();
  assert.equal(await duration().inputValue(), '120');
  await tab('复习与计划');
  await sub('每日推荐与计划');
  assert.equal(await page.getByLabel('新题目标分值', { exact: true }).inputValue(), '25');
  await discard().click();
  await tab('外观与通用');
  assert.equal(await page.locator('input[value="pink"][name="interface-theme"]').isChecked(), true);
  await page.locator('.theme-option-dark').click();
  await discard().click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'pink');
  checks.push('局部填默认值不重置隐藏的学习计划或主题；全局放弃恢复主题预览和最近保存值');

  await tab('练习与计分');
  await duration().fill('70');
  await tab('AI 辅助');
  await page.getByLabel('模型名称', { exact: true }).fill('未保存的独立AI字段');
  assert.equal(await bar().isVisible(), false);
  await tab('练习与计分');
  assert.equal(await duration().inputValue(), '70');
  await page.goBack();
  await page.getByLabel('模型名称', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('模型名称', { exact: true }).inputValue(),
    '未保存的独立AI字段',
  );
  await tab('练习与计分');
  discardDialog = true;
  await page.locator('.sidebar nav').getByRole('link', { name: '知识题库', exact: false }).click();
  assert.match(page.url(), /#\/settings/);
  assert.equal(await duration().inputValue(), '70');
  discardDialog = false;
  await discard().click();
  await tab('AI 辅助');
  await page.getByRole('button', { name: '放弃 AI 修改', exact: true }).click();
  checks.push('AI 与普通配置分别保存且互不丢输入；Back保留分类与编辑；真正离开可取消放弃确认');

  // A background read started before editing can finish after a successful
  // save. Its old version must never become the form's new baseline.
  let releaseAiRead,
    staleReadSeen = false;
  const aiReadGate = new Promise((done) => (releaseAiRead = done));
  const delayedAiRead = async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    staleReadSeen = true;
    await aiReadGate;
    return route.fulfill({ response });
  };
  await page.route('**/api/ai/settings', delayedAiRead);
  await tab('练习与计分');
  await tab('AI 辅助');
  await wait(() => staleReadSeen, 'background AI read captured before editing');
  await page.getByLabel('模型名称', { exact: true }).fill('迟到读取不能覆盖已保存模型');
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await wait(
    async () => (await api('/api/ai/settings')).model === '迟到读取不能覆盖已保存模型',
    'AI settings saved before stale read finishes',
  );
  await wait(
    () => page.getByRole('button', { name: '放弃 AI 修改', exact: true }).isDisabled(),
    'AI draft is clean after saving',
  );
  releaseAiRead();
  await delay(80);
  assert.equal(
    await page.getByLabel('模型名称', { exact: true }).inputValue(),
    '迟到读取不能覆盖已保存模型',
  );
  await page.unroute('**/api/ai/settings', delayedAiRead);

  // Exercise the read→baseline→input timing that previously lost drafts under
  // load. Capture each response before delaying, rather than delaying the read.
  let aiReadIndex = 0;
  const jitterAiRead = async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const index = aiReadIndex++;
    const response = await route.fetch();
    await delay([0, 1, 2, 4, 8, 16, 32][index % 7]);
    return route.fulfill({ response });
  };
  await page.route('**/api/ai/settings', jitterAiRead);
  for (let index = 0; index < 30; index++) {
    const abandon = page.getByRole('button', { name: '放弃 AI 修改', exact: true });
    if (await abandon.isEnabled()) await abandon.click();
    await tab('练习与计分');
    await tab('AI 辅助');
    const text = `时序测试未保存模型${index}`;
    await page.getByLabel('模型名称', { exact: true }).fill(text);
    await delay(40);
    assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), text);
  }
  await page.unroute('**/api/ai/settings', jitterAiRead);
  await page.getByRole('button', { name: '放弃 AI 修改', exact: true }).click();
  checks.push('迟到读取不能覆盖已保存 AI 版本，30轮切换后立即编辑也完整保留未保存输入');

  await tab('练习与计分');
  await duration().fill('65');
  await tab('AI 辅助');
  await page.getByLabel('模型名称', { exact: true }).fill('导入前尚未保存的模型');
  await tab('数据与迁移');
  await sub('迁移');
  // Simulate an external configuration write through the existing service API.
  // The visible settings UI now exposes SQLite migration instead of config ZIPs.
  const bundle = await api('/api/settings/export');
  bundle.system.examDurationMinutes = 45;
  bundle.ai.model = '外部更新后的模型';
  const inspected = await page.request.post(origin + '/api/settings/import/preview', {
    data: { data: bundle },
  });
  assert.ok(inspected.ok(), await inspected.text());
  const imported = await page.request.post(origin + '/api/settings/import', {
    data: { data: bundle, fingerprint: (await inspected.json()).fingerprint, confirmed: true },
  });
  assert.ok(imported.ok(), await imported.text());
  await tab('AI 辅助');
  await page
    .getByText('AI 配置已更新，当前输入仍保留。请放弃 AI 修改以载入最新值，再重新编辑。', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await page.getByLabel('模型名称', { exact: true }).inputValue(),
    '导入前尚未保存的模型',
  );
  await page.getByRole('button', { name: '放弃 AI 修改', exact: true }).click();
  assert.equal(await page.getByLabel('模型名称', { exact: true }).inputValue(), '外部更新后的模型');
  await page.getByLabel('模型名称', { exact: true }).fill('采用外部配置后再次保存');
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/bootstrap'));
  await page.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
  await refreshed;
  await tab('练习与计分');
  assert.equal(await duration().inputValue(), '65');
  await save().click();
  await page
    .getByText(
      '配置已在其他操作中更新，当前输入已保留。请先放弃当前配置修改以载入最新值，再重新编辑，避免覆盖刚导入的配置。',
      { exact: true },
    )
    .waitFor();
  assert.equal((await api('/api/settings')).examDurationMinutes, 45);
  await discard().click();
  assert.equal(await duration().inputValue(), '45');
  checks.push('外部配置更新保留AI和常规未保存输入，旧版本阻止覆盖，显式放弃后采用新值');

  await tab('草稿与历史');
  await sub('学习草稿与作答');
  await maxDraft().fill('2');
  await save().click();
  const retention = page.getByRole('dialog', { name: '确认记录保留范围', exact: true });
  await retention.waitFor();
  assert.equal((await api('/api/attempts?paperId=' + paperId)).length, 3);
  await retention.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await maxDraft().inputValue(), '2');
  await save().click();
  await retention.getByRole('button', { name: '确认保存并清理记录', exact: true }).click();
  await retention.waitFor({ state: 'hidden' });
  await clean();
  assert.equal((await api('/api/attempts?paperId=' + paperId)).length, 2);
  checks.push('降低上限先预览清理数量；取消不丢输入，确认后按原规则清理而不影响其他配置');

  await page.reload();
  await maxDraft().waitFor();
  assert.equal(
    await page
      .locator('.settings-tabs a[aria-current=page]')
      .innerText()
      .then((value) => value.split('\n')[0]),
    '草稿与历史',
  );
  assert.equal(
    await page.locator('.settings-subtabs a[aria-current=page]').innerText(),
    '学习草稿与作答',
  );
  checks.push('刷新恢复主分区和子分类的深链接位置');
  await tab('外观与通用');
  const autosave = page.getByLabel('编辑与作答自动保存等待（毫秒）', { exact: true });
  await autosave.fill('1500');
  await page.evaluate(() => {
    location.hash = '#/settings?tab=missing';
  });
  await autosave.waitFor();
  await wait(
    async () => (await autosave.inputValue()) === '1000',
    'unknown destination starts a fresh guard',
  );
  await autosave.fill('1600');
  discardDialog = true;
  await tab('练习与计分');
  assert.match(page.url(), /tab=missing/);
  assert.equal(await autosave.inputValue(), '1600');
  await page.locator('.sidebar nav').getByRole('link', { name: '知识题库', exact: false }).click();
  assert.match(page.url(), /tab=missing/);
  assert.equal(await autosave.inputValue(), '1600');
  discardDialog = false;
  await discard().click();
  checks.push('未知设置链接建立新的守卫，后续修改在离开及返回有效设置时均受保护');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await tab('外观与通用');
    await page.locator('.theme-option-dark').click();
    await save().click();
    await clean();
    for (const name of ['练习与计分', '草稿与历史', '文件资源', 'AI 辅助', '数据与迁移']) {
      await tab(name);
      await capture('settings-' + width + '-' + name);
    }
    await tab('练习与计分');
    await duration().scrollIntoViewIfNeeded();
    await barVisible();
  }
  checks.push('桌面1440和手机390/320宽度的各分区暗色布局无横向溢出，长表单保存条持续可见');
  harness.assertClean();
  await writeFile(
    resolve(folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        errors: harness.errors,
        external: harness.external,
        isolated: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await harness?.captureFailure(error, { checks });
  throw error;
} finally {
  await harness?.close();
}
