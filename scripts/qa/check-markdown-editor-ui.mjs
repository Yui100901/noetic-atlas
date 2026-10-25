/** Exercise the real Markdown editor against a disposable in-memory service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument } from 'pdf-lib';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/markdown-editor-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-markdown-editor-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('MARKDOWN_EDITOR_READY '+JSON.stringify({origin}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-12000));
const checks = [], errors = [], externalRequests = [], writes = [];
try {
  let state;
  for (let index = 0; index < 300; index++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('MARKDOWN_EDITOR_READY '));
    if (line) { state = JSON.parse(line.slice('MARKDOWN_EDITOR_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr); const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  page.on('request', request => { const path = new URL(request.url()).pathname; if ((path.startsWith('/api/documents') || /^\/api\/document-drafts\/[^/]+\/publish$/.test(path)) && ['POST', 'PUT'].includes(request.method())) writes.push({ method: request.method(), path }); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data) => { const response = await page.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) }); assert.equal(response.status(), 200, await response.text()); return response.json(); };
  let navigation = 0;
  const go = async path => {
    await page.goto(origin + '/?markdown-ui=' + ++navigation + '#/' + path); await page.waitForLoadState('networkidle');
    const picker = page.getByRole('dialog', { name: '继续资料草稿', exact: true });
    if (await picker.count()) await picker.getByRole('button', { name: path === 'documents/new' ? '新建资料' : '重新编辑', exact: true }).click();
  };
  const body = () => page.getByLabel('资料正文', { exact: true });
  const tool = name => page.getByRole('button', { name, exact: true });
  const edit = async () => { await page.getByRole('tab', { name: '编辑', exact: true }).click(); await body().waitFor(); };
  const preview = async () => { await page.getByRole('tab', { name: '预览', exact: true }).click(); };
  const select = async (text, start, end = start) => {
    await body().fill(text);
    await body().evaluate((element, range) => { element.focus(); element.setSelectionRange(range.start, range.end); element.dispatchEvent(new Event('select', { bubbles: true })); }, { start, end });
  };
  const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
  const capture = async name => { await noOverflow(); await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true }); };

  await go('documents/new'); await body().waitFor(); await page.getByLabel('资料标题 *', { exact: true }).fill('Markdown编辑验收');
  await page.getByRole('tablist', { name: 'Markdown编辑模式', exact: true }).waitFor();
  for (const name of ['二级标题', '粗体', '斜体', '删除线', '引用', '行内代码', '代码块', '无序列表', '有序列表', '任务列表', '插入链接', '插入表格', '分隔线', '撤销', '重做']) assert.equal(await tool(name).count(), 1, name);
  await select('甲猫乙', 1, 2); await tool('粗体').click(); assert.equal(await body().inputValue(), '甲**猫**乙');
  assert.equal(await body().evaluate(element => document.activeElement === element), true, 'toolbar returns text focus');
  await body().press('Control+z'); assert.equal(await body().inputValue(), '甲猫乙');
  await body().press('Control+Shift+z'); assert.equal(await body().inputValue(), '甲**猫**乙');
  checks.push('工具栏完整，中文选区应用粗体并保留焦点，撤销与重做恢复原内容');

  await select('前text后', 1, 5); await body().press('Control+i'); assert.match(await body().inputValue(), /^前\*text\*后$/);
  await select('前text后', 1, 5); await body().press('Control+k'); assert.match(await body().inputValue(), /^前\[text\]\([^)]+\)后$/);
  await select('前text后', 1, 5); await body().press('Control+b'); assert.equal(await body().inputValue(), '前**text**后');
  await select('开头 结尾', 3); await tool('行内代码').click(); const inline = await body().inputValue(); assert.ok(inline.startsWith('开头 ') && inline.endsWith('结尾')); assert.match(inline, /`[^`]+`/);
  await select('const x = 1;\nreturn x;', 0, 22); await tool('代码块').click(); assert.match(await body().inputValue(), /```[\s\S]*const x = 1;[\s\S]*return x;[\s\S]*```/);
  await select('alpha\nbeta', 0, 10); await tool('无序列表').click(); assert.match(await body().inputValue(), /^[-*+] alpha\n[-*+] beta$/);
  assert.equal((await api('/api/documents')).length, 0); assert.equal(writes.length, 0, 'format actions never submit the document form');
  checks.push('Ctrl+B/I/K、光标插入行内代码、多行代码块和列表有效，格式操作不会误提交资料');

  const content = '# 编辑器验收\n\n**粗体**与*斜体*、~~删除~~。\n\n> 一段引用\n\n- [ ] 待处理\n- [x] 已完成\n\n| 名称 | 值 |\n| --- | --- |\n| 测试 | 42 |\n\n```ts\nconst answer = 42;\n```\n';
  await body().fill(content); await preview();
  await page.getByRole('heading', { name: '编辑器验收', exact: true }).waitFor();
  assert.equal(await page.locator('.markdown-preview table').count(), 1); assert.equal(await page.locator('.markdown-preview input[type=checkbox]').count(), 2);
  assert.equal(await page.locator('.markdown-preview pre code').innerText(), 'const answer = 42;\n');
  await edit(); assert.equal(await body().inputValue(), content); await capture('editor-desktop');
  checks.push('编辑和预览可切换，GFM表格、任务列表、删除线、引用和代码正确渲染，返回不丢正文');

  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await select('开头\n\n结尾', 2);
  await page.getByLabel('向资料上传图片', { exact: true }).setInputFiles({ name: '插图.png', mimeType: 'image/png', buffer: imageBytes });
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="资料正文"]')?.value.includes('!['));
  const withImage = await body().inputValue(); assert.ok(withImage.startsWith('开头')); assert.ok(withImage.endsWith('结尾')); assert.ok(withImage.indexOf('![') < withImage.indexOf('结尾'));
  await preview(); const picture = page.locator('.markdown-preview img'); await picture.waitFor(); await picture.evaluate(image => image.decode());
  await edit(); await body().press('Control+z'); assert.equal(await body().inputValue(), '开头\n\n结尾');
  await body().press('Control+Shift+z'); assert.equal(await body().inputValue(), withImage);
  // Also cover a user moving the cursor with real key events. The first
  // upload intentionally relied on the actual DOM range rather than a ref
  // updated by a prior synthetic onSelect event.
  await body().press('Control+z'); await body().press('Control+Home'); await body().press('ArrowRight'); await body().press('ArrowRight');
  await page.getByLabel('向资料上传图片', { exact: true }).setInputFiles({ name: '键盘插图.png', mimeType: 'image/png', buffer: imageBytes });
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="资料正文"]')?.value.includes('键盘插图'));
  const keyboardImage = await body().inputValue(); assert.ok(keyboardImage.startsWith('开头') && keyboardImage.endsWith('结尾')); assert.ok(keyboardImage.indexOf('![') < keyboardImage.indexOf('结尾'));
  await body().press('Control+z'); assert.equal(await body().inputValue(), '开头\n\n结尾');
  await body().press('Control+Shift+z'); assert.equal(await body().inputValue(), keyboardImage);
  assert.equal((await api('/api/documents')).length, 0);
  checks.push('图片上传到当前光标位置，预览本地托管图片正常，上传插图也能撤销和重做');

  await body().fill(content + '\n' + withImage); const savedBody = await body().inputValue();
  const createdResponse = page.waitForResponse(response => /^\/api\/document-drafts\/[^/]+\/publish$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存资料', exact: true }).click(); const created = await createdResponse; assert.equal(created.status(), 200); const document = await created.json();
  await page.waitForURL(new RegExp('#/documents/' + document.id)); assert.equal((await api('/api/documents/' + document.id)).bodyMarkdown, savedBody);
  await page.getByRole('link', { name: '编辑资料', exact: true }).click(); await body().waitFor(); assert.equal(await body().inputValue(), savedBody);
  await body().fill(savedBody + '\n编辑后仍完整。');
  const updateResponse = page.waitForResponse(response => /^\/api\/document-drafts\/[^/]+\/publish$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存资料', exact: true }).click(); assert.equal((await updateResponse).status(), 200);
  await page.waitForURL(new RegExp('#/documents/' + document.id)); assert.match((await api('/api/documents/' + document.id)).bodyMarkdown, /编辑后仍完整。$/); assert.equal((await api('/api/documents')).length, 1);
  checks.push('工具栏编辑的资料可保存、阅读和重新编辑，原Markdown及图片引用保持完整');

  await go('documents/new'); const imported = '# UTF-8资料\n\n中文正文与 *Markdown*。';
  await page.getByLabel('上传资料文件', { exact: true }).setInputFiles({ name: '导入资料.md', mimeType: 'text/markdown', buffer: Buffer.from(imported) });
  await body().waitFor(); await page.waitForFunction(value => document.querySelector('textarea[aria-label="资料正文"]')?.value === value, imported);
  assert.equal(await page.getByLabel('资料标题 *', { exact: true }).inputValue(), '导入资料'); await preview(); await page.getByRole('heading', { name: 'UTF-8资料', exact: true }).waitFor(); await edit(); assert.equal(await body().inputValue(), imported);
  checks.push('UTF-8 Markdown上传仍可进入工具栏编辑与预览，不自动提交');

  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  await page.setViewportSize({ width: 390, height: 844 }); await go('documents/' + document.id + '/edit'); await body().waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.ok((await body().boundingBox()).width >= 200, 'mobile text area remains readable'); await capture('editor-dark-mobile');
  await preview(); await page.getByRole('heading', { name: '编辑器验收', exact: true }).waitFor(); await capture('preview-dark-mobile'); await edit();
  assert.equal(await body().inputValue(), savedBody + '\n编辑后仍完整。');
  checks.push('390px暗色工具栏可换行，正文和表格预览无页面溢出，切换模式保留文本');

  await go('documents/new'); const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  await page.getByLabel('上传资料文件', { exact: true }).setInputFiles({ name: 'PDF验收.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.getByRole('button', { name: '改为Markdown', exact: true }).waitFor(); assert.equal(await page.getByRole('tablist', { name: 'Markdown编辑模式', exact: true }).count(), 0);
  await page.getByRole('button', { name: '改为Markdown', exact: true }).click(); await body().waitFor(); assert.equal(await body().inputValue(), '');
  checks.push('PDF上传继续使用原附件流程，仅切回Markdown时显示编辑组件');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, errors, externalRequests, isolated: true, databasePath: ':memory:', documentWrites: writes };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ url: page?.url(), checks, stderr }); throw error;
} finally { await browser?.close(); server.kill(); }
