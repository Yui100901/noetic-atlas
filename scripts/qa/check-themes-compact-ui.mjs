/** Compact study/settings layout and persisted themes on an isolated service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/themes-compact-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-themes-compact-ui-seed',staticRoot:'dist/web',logger:false});
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,response.body);return response.json();};
const system=await api('/api/settings');await api('/api/settings','PUT',{settings:{...system,reviewScheduling:{...system.reviewScheduling,strategy:'fixed'}}});
await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[{id:'COMPACT-Q',title:'紧凑学习情况验收',type:'true_false',stemMarkdown:['说明数据与展示的边界。','','| 项目 | 范围 |','| --- | --- |','| 学习统计 | 真实提交 |','','~~~ts','const answered = true;','~~~'].join('\\n'),answerMarkdown:'正确，保留独立的学习与历史记录。',explanationMarkdown:'统计保留完整语义，缩小展示不丢失信息。',correctAnswers:['true'],status:'published'}]}});
const paper=await api('/api/papers','POST',{title:'主题与学习情况验收题集',mode:'manual',questionIds:['COMPACT-Q'],scoring:{enabled:false}});
for(const value of ['true','false']){const draft=await api('/api/quick-practice','POST',{questionId:'COMPACT-Q'});await api('/api/attempts/'+draft.id+'/submit','POST',{answers:{'COMPACT-Q':{value}}});}
await api('/api/study/COMPACT-Q','PUT',{notes:'查阅时可编辑的独立笔记。',mastery:2});
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('THEMES_COMPACT_READY '+JSON.stringify({origin,paperId:paper.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-12000));
const checks = [], errors = [], externalRequests = [], measurements = {};
try {
  let state;
  for (let index = 0; index < 300; index++) {
    if (server.exitCode !== null) throw Error('Fixture failed: ' + stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('THEMES_COMPACT_READY '));
    if (line) { state = JSON.parse(line.slice('THEMES_COMPACT_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr); const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async path => { const response = await page.request.get(origin + path); assert.ok(response.ok(), await response.text()); return response.json(); };
  let navigation = 0;
  const navigate = async path => { await page.goto(origin + '/?themes-qa=' + ++navigation + '#/' + path); await page.locator('.page-header').waitFor(); await page.waitForLoadState('networkidle'); };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'document overflow');
  const snapshot = async name => { await noOverflow(); await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true }); };
  const counts = async scope => scope.locator('.question-history-stats').evaluate(node => Object.fromEntries(Array.from(node.children).map(item => [item.querySelector('dt').textContent.trim(), Number(item.querySelector('dd').textContent.replace(/[^\d]/g, ''))])));
  const waitTheme = theme => page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
  const setTheme = async theme => { await page.locator(`.theme-option-${theme}`).click(); assert.equal(await page.locator(`input[name="interface-theme"][value="${theme}"]`).isChecked(), true); await waitTheme(theme); };
  const saveTheme = async theme => { await setTheme(theme); const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/settings' && r.request().method() === 'PUT'); await page.getByRole('button', { name: '保存系统配置', exact: true }).click(); assert.equal((await response).status(), 200); await page.waitForFunction(value => localStorage.getItem('noetic-atlas-theme') === value, theme); assert.equal((await api('/api/settings')).theme, theme); await page.reload(); await page.waitForLoadState('networkidle'); await waitTheme(theme); };
  const luminance = color => { const parts = color.match(/[\d.]+/g)?.slice(0, 3).map(Number); assert.ok(parts?.length === 3, 'unsupported computed color: ' + color); const rgb = parts.map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
  const darkReadable = async (locator, label) => { const colors = await locator.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color })); const bg = luminance(colors.background), fg = luminance(colors.color); assert.ok(bg < .3 && fg > bg, label + ' dark colors: ' + JSON.stringify(colors)); measurements['dark-' + label] = colors; };
  const readableText = async (locator, label) => {
    const colors = await locator.evaluate(node => {
      const context = document.createElement('canvas').getContext('2d');
      const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
      const composite = (foreground, background) => foreground.slice(0, 3).map((value, index) => value * foreground[3] / 255 + background[index] * (1 - foreground[3] / 255));
      const layers = []; for (let parent = node; parent; parent = parent.parentElement) layers.unshift(parent);
      const background = layers.reduce((current, layer) => composite(rgba(getComputedStyle(layer).backgroundColor), current), [255, 255, 255]);
      const color = getComputedStyle(node).color;
      return { color, foreground: composite(rgba(color), background), background };
    });
    const foreground = luminance('rgb(' + colors.foreground.join(',') + ')'), background = luminance('rgb(' + colors.background.join(',') + ')');
    const contrast = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    assert.ok(contrast >= 4.5, label + ' text contrast: ' + contrast.toFixed(2) + ' ' + JSON.stringify(colors));
    return { color: colors.color, background: colors.background, contrast: Number(contrast.toFixed(2)) };
  };
  const primaryColors = { pink: 'rgb(221, 170, 204)', sky: 'rgb(102, 204, 255)', mint: 'rgb(57, 197, 187)' };
  const sidebarOnly = process.env.THEMES_SIDEBAR_ONLY === '1';

  if (sidebarOnly) {
    for (const theme of ['pink', 'sky', 'mint']) {
      await navigate('settings'); await saveTheme(theme);
      const active = page.locator('.sidebar-bottom > a.active');
      assert.equal(await active.innerText(), '系统配置');
      measurements[theme + '-sidebar'] = await readableText(active, theme + ' active settings link');
      await snapshot(theme + '-settings-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await snapshot(theme + '-settings-mobile');
      await page.getByRole('button', { name: '打开菜单', exact: true }).click();
      measurements[theme + '-sidebar-mobile'] = await readableText(active, theme + ' mobile active settings link');
      await snapshot(theme + '-settings-sidebar-mobile');
      await page.locator('.sidebar-scrim').click({ position: { x: 370, y: 80 } }); await page.setViewportSize({ width: 1440, height: 1000 });
      checks.push(theme + '设置页侧栏当前入口在桌面与手机均有足够文字对比度');
    }
  } else {

  await navigate('questions/COMPACT-Q');
  const statistics = page.locator('.detail-aside .question-study-statistics'); await statistics.locator('.question-history-stats').waitFor();
  assert.deepEqual(await counts(statistics), { 实际作答: 2, 正确: 1, 部分正确: 0, 错误: 1, 未判: 0 });
  const studyCard = page.locator('.detail-aside .review-card');
  measurements.study = await studyCard.evaluate(node => ({ height: node.getBoundingClientRect().height, statsHeight: node.querySelector('.question-study-statistics').getBoundingClientRect().height, updateBottom: node.querySelector('.full-width').getBoundingClientRect().bottom, viewportHeight: innerHeight }));
  assert.ok(measurements.study.statsHeight < 220, JSON.stringify(measurements.study));
  assert.ok(measurements.study.updateBottom <= measurements.study.viewportHeight, 'date update should fit initial desktop viewport: ' + JSON.stringify(measurements.study));
  assert.equal(await statistics.getByText('跨题集与随机自测累计。', { exact: false }).isVisible(), false);
  await snapshot('compact-study-desktop');
  const greenButton = await page.locator('.header-actions .button.primary').first().evaluate(node => getComputedStyle(node).backgroundColor);
  checks.push('累计计数准确；统计紧凑且口径默认折叠，1440x1000首屏可看到复习日期与更新按钮');

  await page.setViewportSize({ width: 1366, height: 768 }); await page.evaluate(() => window.scrollTo(0, 0));
  measurements.studyLaptop = await studyCard.evaluate(node => ({ height: node.getBoundingClientRect().height, statsHeight: node.querySelector('.question-study-statistics').getBoundingClientRect().height, updateBottom: node.querySelector('.full-width').getBoundingClientRect().bottom, viewportHeight: innerHeight }));
  assert.ok(measurements.studyLaptop.updateBottom <= measurements.studyLaptop.viewportHeight, 'date update should fit common laptop viewport: ' + JSON.stringify(measurements.studyLaptop));
  await snapshot('compact-study-laptop'); await page.setViewportSize({ width: 1440, height: 1000 });
  checks.push('1366x768常见桌面首屏仍可看到完整学习情况与日期更新按钮');

  await navigate('papers/' + state.paperId); await page.getByLabel('查看题目：紧凑学习情况验收', { exact: true }).click();
  const reader = page.locator('main'); await reader.locator('.question-history-stats').waitFor();
  assert.deepEqual(await counts(reader), { 实际作答: 2, 正确: 1, 部分正确: 0, 错误: 1, 未判: 0 });
  await snapshot('compact-set-reader-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await noOverflow();
  assert.ok(await reader.evaluate(node => node.scrollWidth <= node.clientWidth + 1)); await snapshot('compact-set-reader-mobile');
  checks.push('题集查看复用紧凑学习情况，数据一致，390px正文与侧栏无横向溢出');

  await page.setViewportSize({ width: 1440, height: 1000 }); await navigate('settings');
  await page.locator('#system-settings-form input[type="number"]').first().waitFor();
  measurements.settings = await page.locator('#system-settings-form input[type="number"]:visible').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, label: node.closest('.field')?.querySelector('.field-label')?.textContent })));
  assert.ok(measurements.settings.every(item => item.width > 0 && item.width <= 170), JSON.stringify(measurements.settings));
  const columns = await page.locator('.settings-sections-grid .form-grid').first().evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').filter(Boolean).length);
  assert.ok(columns >= 3, 'desktop settings should use available width for multiple fields'); await snapshot('compact-settings-desktop');
  await setTheme('dark'); assert.equal((await api('/api/settings')).theme, 'green');
  await page.getByRole('button', { name: '文件资源', exact: true }).click(); await waitTheme('green');
  await navigate('questions/COMPACT-Q'); await waitTheme('green');
  assert.equal(await page.evaluate(() => localStorage.getItem('noetic-atlas-theme')), 'green');
  checks.push('配置数字输入桌面不超过170px并多列组织；主题选择可预览，未保存离开恢复已确认主题');

  for (const theme of ['dark', 'pink', 'sky', 'mint', 'green']) {
    await navigate('settings'); await saveTheme(theme);
    if (primaryColors[theme]) measurements[theme + '-sidebar'] = await readableText(page.locator('.sidebar-bottom > a.active'), theme + ' active settings link');
    await snapshot(theme + '-settings-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await snapshot(theme + '-settings-mobile');
    await page.setViewportSize({ width: 1440, height: 1000 }); await navigate('questions/COMPACT-Q'); await waitTheme(theme); await statistics.locator('.question-history-stats').waitFor();
    assert.equal((await api('/api/bootstrap')).settings.theme, theme);
    const primary = page.locator('.header-actions .button.primary').first();
    const buttonColor = await primary.evaluate(node => getComputedStyle(node).backgroundColor);
    if (primaryColors[theme]) {
      assert.equal(buttonColor, primaryColors[theme], theme + ' primary must use the requested exact color');
      assert.notEqual(buttonColor, greenButton, 'primary button kept green in ' + theme);
      const contrast = { primary: await readableText(primary, theme + ' primary') };
      await primary.hover(); await delay(200); contrast.primaryHover = await readableText(primary, theme + ' primary hover');
      await page.mouse.move(0, 0); await delay(200);
      contrast.link = await readableText(page.locator('.back-link').first(), theme + ' page link');
      contrast.body = await readableText(page.locator('.question-body .markdown').first(), theme + ' body');
      measurements[theme + '-contrast'] = contrast;
    }
    if (theme === 'dark') {
      await darkReadable(page.locator('.detail-main .question-body'), 'card'); await darkReadable(page.locator('.notes-area'), 'input');
      const markdown = await page.locator('.question-body .markdown').first().evaluate(node => getComputedStyle(node).color); assert.ok(luminance(markdown) > .4, 'dark markdown text must be readable');
      measurements['dark-main'] = await page.locator('html').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
      assert.ok(luminance(measurements['dark-main'].background) < .3);
    }
    await snapshot(theme + '-question-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await snapshot(theme + '-question-mobile');
    if (theme === 'dark') {
      await page.setViewportSize({ width: 1440, height: 1000 }); await navigate('papers/' + state.paperId); await page.getByLabel('查看题目：紧凑学习情况验收', { exact: true }).click();
      await reader.locator('.question-history-stats').waitFor(); await darkReadable(reader.locator('.question-viewer-study'), 'set-reader'); await snapshot('dark-reader-desktop'); await page.setViewportSize({ width: 390, height: 844 }); await snapshot('dark-reader-mobile');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    checks.push(theme + '主题保存到SQLite与缓存，刷新及跨页面一致，桌面/手机布局正常');
  }
  }
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, measurements, browserErrors: errors, externalRequests, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, sidebarOnly ? 'sidebar-report.json' : 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error({ url: page?.url(), checks, measurements, stderr }); throw error; }
finally { await browser?.close(); server.kill(); }
