/** Grouped set actions run only on a disposable in-memory service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/paper-actions-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-paper-actions-ui-seed',staticRoot:'dist/web',logger:false});
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,response.body);return response.json();};
await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[{id:'ACTION-Q',title:'菜单练习主观题',type:'short_answer',stemMarkdown:'解释原子性。',answerMarkdown:'全部提交或回滚。',status:'published'},{id:'ACTION-T',title:'菜单练习判断题',type:'true_false',stemMarkdown:'事务可以保证原子性吗？',correctAnswers:['true'],answerMarkdown:'正确',status:'published'}]}});
const paper=async title=>api('/api/papers','POST',{title,mode:'manual',questionIds:['ACTION-Q','ACTION-T'],scoring:{enabled:false}});
const main=await paper('分组操作验收题集'),fresh=await paper('全新练习验收题集'),archived=await paper('恢复验收题集'),removable=await paper('删除验收题集');
const draft=await api('/api/papers/'+main.id+'/attempts','POST');await api('/api/attempts/'+draft.id,'PUT',{answers:{'ACTION-Q':{value:'原有草稿回答'}}});
await api('/api/papers/'+archived.id,'DELETE');
const origin=await app.listen({host:'127.0.0.1',port:0});
console.log('PAPER_ACTIONS_READY '+JSON.stringify({origin,paperId:main.id,freshId:fresh.id,archivedId:archived.id,removableId:removable.id,draftId:draft.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page, nextConfirmation = true;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-12000));
const checks = [], errors = [], externalRequests = [], confirmations = [];
try {
  let state;
  for (let index = 0; index < 300; index++) { if (server.exitCode !== null) throw Error('Fixture failed: ' + stderr); const line = stdout.split(/\r?\n/).find(value => value.startsWith('PAPER_ACTIONS_READY ')); if (line) { state = JSON.parse(line.slice('PAPER_ACTIONS_READY '.length)); break; } await delay(100); }
  assert.ok(state, stderr); const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { confirmations.push(dialog.message()); const accept = nextConfirmation; nextConfirmation = true; void (accept ? dialog.accept() : dialog.dismiss()); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, status = 200) => { const response = await page.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) }); assert.equal(response.status(), status, path + ': ' + await response.text()); return response.json(); };
  let navigation = 0;
  const navigate = async id => { await page.goto(origin + '/?paper-actions-qa=' + ++navigation + '#/papers/' + encodeURIComponent(id)); await page.getByRole('heading', { name: '题集内容', exact: false }).waitFor(); await page.waitForLoadState('networkidle'); };
  const modeTrigger = () => page.getByRole('button', { name: '选择练习模式', exact: true });
  const outputTrigger = () => page.getByRole('button', { name: '导出与分享', exact: true });
  const manageTrigger = () => page.getByRole('button', { name: '题集管理', exact: true });
  const item = name => page.getByRole('menuitem', { name });
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'document overflow');
  const screenshot = async name => { await noOverflow(); const menuOpen = await page.getByRole('menu').count() > 0; await page.screenshot({ path: resolve(output, name + '.png'), fullPage: !menuOpen }); };

  await navigate(state.paperId);
  assert.equal(await page.locator('.header-actions button').count(), 4, 'the grouped header should expose one split action and two menus');
  await modeTrigger().click(); await item(/^普通练习/).waitFor(); await item(/^考试模式/).waitFor();
  await page.keyboard.press('Escape'); assert.equal(await modeTrigger().getAttribute('aria-expanded'), 'false');
  await modeTrigger().click(); await page.getByRole('heading', { name: '分组操作验收题集', exact: true }).click(); assert.equal(await modeTrigger().getAttribute('aria-expanded'), 'false');
  await modeTrigger().focus(); await page.keyboard.press('ArrowDown'); await item(/^普通练习/).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'menuitem');
  await page.keyboard.press('End'); assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /考试模式/);
  await page.keyboard.press('Home'); assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /普通练习/); await page.keyboard.press('Escape');
  assert.equal(await modeTrigger().evaluate(node => document.activeElement === node), true);
  checks.push('页头收敛为三个操作组，模式菜单可键盘选择、Escape和外点收起');

  await page.getByRole('button', { name: '开始练习', exact: true }).click();
  const drafts = page.getByRole('dialog', { name: '继续之前的作答？', exact: true }); await drafts.waitFor();
  await drafts.locator('.draft-option').first().click(); await page.waitForURL(new RegExp(state.draftId));
  assert.equal(await page.getByLabel('我的回答', { exact: true }).inputValue(), '原有草稿回答');
  await navigate(state.freshId); await modeTrigger().click(); await item(/^普通练习/).click(); await page.waitForURL(/#\/attempts\//);
  const freshAttempt = await api('/api/attempts/' + decodeURIComponent(page.url().split('/').pop())); assert.equal(freshAttempt.practiceMode, 'practice');
  checks.push('开始练习继续原草稿，普通练习菜单仍可新开独立作答');

  await navigate(state.paperId); await modeTrigger().click(); await item(/^考试模式/).click();
  const exam = page.getByRole('dialog', { name: '开始限时考试', exact: true }); await exam.waitFor();
  assert.equal(await exam.getByLabel('考试时长（分钟）', { exact: true }).inputValue(), '120');
  const prior = (await api('/api/attempts')).length; await exam.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await api('/api/attempts')).length, prior); assert.equal(await modeTrigger().getAttribute('aria-expanded'), 'false');
  checks.push('考试模式收进模式菜单，原120分钟设置保留，取消不创建考试');

  await outputTrigger().click(); await item(/^导出题集/).click();
  const exported = page.getByRole('dialog', { name: '导出题集', exact: true }); await exported.waitFor();
  assert.equal(await outputTrigger().getAttribute('aria-expanded'), 'false');
  await exported.locator('input[value="answers"]').check(); await exported.getByRole('button', { name: '取消', exact: true }).click();
  await outputTrigger().click(); await item(/^分享题集/).click();
  const shared = page.getByRole('dialog', { name: '分享内容', exact: true }); await shared.waitFor();
  await shared.getByRole('button', { name: '导出完整JSON分享包', exact: true }).waitFor(); assert.equal(await outputTrigger().getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Escape'); await shared.waitFor({ state: 'hidden' });
  checks.push('导出与分享合并入口，选择后菜单关闭且独立弹窗正常保留与关闭');

  await manageTrigger().click(); await item(/^调整题目与分值/).click(); await page.getByRole('button', { name: '保存题集', exact: true }).waitFor();
  assert.match(page.url(), /\/edit$/); await navigate(state.paperId);
  nextConfirmation = false; await manageTrigger().click(); await item(/^归档题集/).click(); assert.equal((await api('/api/papers/' + state.paperId)).archived, false);
  await manageTrigger().click(); await item(/^归档题集/).click(); await page.waitForURL(/#\/papers$/);
  await navigate(state.paperId); assert.equal((await api('/api/papers/' + state.paperId)).archived, true); assert.equal(await page.getByRole('button', { name: '开始练习', exact: true }).isDisabled(), true); assert.equal(await modeTrigger().isDisabled(), true);
  await manageTrigger().click(); await item(/^恢复题集/).click(); await page.waitForFunction(() => !document.querySelector('.header-actions button[disabled]')); assert.equal((await api('/api/papers/' + state.paperId)).archived, false);
  checks.push('题集管理保留编辑与归档确认，归档后禁练习，恢复后可继续');

  await navigate(state.removableId); nextConfirmation = false; await manageTrigger().click(); await item(/^永久删除/).click(); await api('/api/papers/' + state.removableId);
  assert.ok(confirmations.at(-1).includes('永久删除'));
  await manageTrigger().click(); await item(/^永久删除/).click(); await page.waitForURL(/#\/papers$/); await api('/api/papers/' + state.removableId, 'GET', undefined, 404);
  checks.push('永久删除收在管理菜单，取消确认不删除，确认后仅删除隔离测试副本');

  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  await navigate(state.paperId); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await outputTrigger().click(); await item(/^导出题集/).waitFor(); await screenshot('dark-menu-desktop'); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 }); await manageTrigger().click(); await item(/^永久删除/).waitFor(); await screenshot('grouped-management-mobile');
  assert.ok(await page.getByRole('menu').evaluate(node => node.getBoundingClientRect().right <= innerWidth + 1)); await page.keyboard.press('Escape');
  await modeTrigger().click(); await item(/^考试模式/).waitFor(); await screenshot('grouped-practice-mobile'); await item(/^考试模式/).click(); await exam.getByLabel('考试时长（分钟）', { exact: true }).fill('10');
  await exam.getByRole('button', { name: '开始考试', exact: true }).click(); await page.waitForURL(/#\/attempts\//);
  const examId = decodeURIComponent(page.url().split('/').pop()); const active = await api('/api/attempts/' + examId); assert.equal(active.practiceMode, 'exam'); assert.equal(active.durationMinutes, 10);
  await api('/api/attempts/' + examId + '/submit', 'POST', { answers: {} });
  checks.push('暗色桌面和390px菜单无溢出，手机仍可开始设置时长的考试');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, confirmations, browserErrors: errors, externalRequests, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error({ url: page?.url(), checks, stderr }); throw error; }
finally { await browser?.close(); server.kill(); }
