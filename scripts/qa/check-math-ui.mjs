/** Formula acceptance uses isolated fixtures, local fonts and a real browser PDF export. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const harness = await startBrowserHarness({
  name: 'math-ui',
  setup: String.raw`
const api=async(url,method='GET',payload,status=200)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,status,response.body);return response.json();};
const stem='行内分数 $\\frac{a}{b}$ 与单位 $9.8\\,\\mathrm{m/s^2}$。\n\n独立公式：\n\n$$\n\\int_0^1 x\\,\\mathrm{d}x=\\frac{1}{2}\n$$\n\n化学反应：\n\n$$\n\\ce{2H2 + O2 -> 2H2O}\n$$\n\n矩阵：\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n\n| 符号 | 含义 |\n| --- | --- |\n| $\\alpha$ | 系数 |\n| $\\ce{SO4^2-}$ | 硫酸根 |\n\n代码保持原文：\n\n\x60\x60\x60js\nconst price = "$10";\n\x60\x60\x60';
const values=[{id:'MATH',title:'科学与化学表达',mathEnabled:true,stemMarkdown:stem,answerMarkdown:'$$\n\\sum_{i=1}^{n}i=\\frac{n(n+1)}{2}\n$$',explanationMarkdown:'反应物与生成物的原子数应守恒。$\\ce{SO4^2-}$ 带两个负电荷。'},{id:'CASH',title:'旧内容金额',stemMarkdown:'总价 $10，折扣 $2。',answerMarkdown:'代码 \x60$HOME\x60 保留原文。'},{id:'INVALID',title:'公式错误与安全回退',mathEnabled:true,stemMarkdown:'$\\badcommand{x}$ 与 $\\href{https://invalid.test}{x}$。<script>window.__mathUnsafe=true</script>',answerMarkdown:'源码保留可修订。'},{id:'WIDE',title:'宽公式',mathEnabled:true,stemMarkdown:'$$\n'+Array.from({length:60},(_,i)=>'x_{'+i+'}').join('+')+'\n$$',answerMarkdown:'宽公式在卡片内滚动。'}];
for(const value of values){const q=await api('/api/questions','POST',{type:'short_answer',...value},201);await api('/api/questions/review','POST',{ids:[q.id],action:'approve',confirmed:true,expectedUpdatedAt:{[q.id]:q.updatedAt}});}
await api('/api/documents','POST',{id:'BOOK',title:'公式教材',mathEnabled:true,bodyMarkdown:'# 科学表达\n\n'+stem},201);
const paper=await api('/api/papers','POST',{title:'公式与专业表达验收',mode:'manual',questionIds:['MATH','CASH'],scoring:{enabled:false}},201);
return{paperId:paper.id,stem};`,
});
const { page, origin, folder } = harness,
  checks = [],
  requests = [];
page.on('request', (request) => requests.push(request.url()));
const api = (path, method = 'GET', body) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { path, method, body },
  );
const open = async (hash) => {
  await page.goto(origin + '/' + hash);
  await page.locator('main').waitFor();
};
const wait = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('Condition did not settle');
};
try {
  await open('#/questions/CASH');
  await page.getByText('总价 $10，折扣 $2。', { exact: true }).waitFor();
  assert.equal(await page.locator('.formula').count(), 0);
  assert.equal(
    requests.some((url) => /katex.min-.*\.js|KaTeX_.*woff/.test(url)),
    false,
  );
  checks.push('legacy currency/code and lazy math loading');
  await open('#/questions/MATH');
  await wait(async () => (await page.locator('.formula .katex').count()) >= 7);
  assert.equal(await page.locator('.formula-error').count(), 0);
  assert.equal(await page.locator('.math-format-warning').count(), 0);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.getByRole('button', { name: '复制公式源码', exact: true }).first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), String.raw`\frac{a}{b}`);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = (command) => {
      if (command !== 'copy') return false;
      window.__copiedFallback = document.querySelector('textarea[data-copy-fallback]')?.value;
      return true;
    };
  });
  await page.getByRole('button', { name: '复制公式源码', exact: true }).first().click();
  assert.equal(await page.evaluate(() => window.__copiedFallback), String.raw`\frac{a}{b}`);
  assert.equal(await page.locator('textarea[data-copy-fallback]').count(), 0);
  await page.screenshot({ path: resolve(folder, 'formula-desktop.png'), fullPage: true });
  checks.push('fractions, units, chemistry, matrices, tables and copy source');
  await open('#/questions/INVALID');
  await page.locator('.formula-error').first().waitFor();
  assert.equal(await page.locator('.formula-error').count(), 2);
  assert.equal(await page.evaluate(() => window.__mathUnsafe), undefined);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: resolve(folder, 'formula-dark.png'), fullPage: true });
  checks.push('visible invalid/unsafe source fallback');
  await open('#/questions/MATH/edit');
  const stem = page.locator('textarea[aria-label="题干 Markdown"]'),
    editor = page.locator('.markdown-editor').filter({ has: stem });
  await stem.waitFor();
  const original = await stem.inputValue();
  await stem.focus();
  await stem.evaluate((node) => node.setSelectionRange(node.value.length, node.value.length));
  await editor.getByRole('button', { name: '插入公式', exact: true }).click();
  await editor.getByRole('button', { name: '化学反应', exact: true }).click();
  await editor.getByRole('button', { name: '插入公式', exact: true }).last().click();
  assert.ok(
    (await stem.inputValue()).length > original.length,
    'formula insertion must change source',
  );
  const inserted = await stem.inputValue();
  await editor.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await stem.inputValue(), original);
  await editor.getByRole('button', { name: '重做', exact: true }).click();
  assert.equal(await stem.inputValue(), inserted);
  await editor.getByRole('tab', { name: '预览', exact: true }).click();
  await wait(async () => (await editor.locator('.katex').count()) >= 8).catch(async (error) => {
    console.log(
      JSON.stringify({
        source: await stem.inputValue(),
        count: await editor.locator('.katex').count(),
      }),
    );
    throw error;
  });
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await wait(async () => (await api('/api/questions/MATH')).stemMarkdown !== original);
  assert.equal((await api('/api/questions/MATH')).mathEnabled, true);
  checks.push('selection-aware template insertion, undo/redo, preview and save');
  await open('#/documents/BOOK');
  await wait(async () => (await page.locator('.katex').count()) >= 7);
  checks.push('Markdown library formula rendering');
  const attempt = await api('/api/papers/' + harness.state.paperId + '/attempts', 'POST', {});
  await open('#/attempts/' + attempt.id);
  const card = page.locator('.exam-question').first(),
    answer = card.getByRole('textbox', { name: '我的回答', exact: true }),
    answerEditor = card.locator('.markdown-editor');
  await answer.fill('预算 $10，余额 $2。');
  await answerEditor.getByRole('tab', { name: '预览', exact: true }).click();
  assert.equal(await answerEditor.locator('.formula').count(), 0);
  await answerEditor.getByRole('tab', { name: '编辑', exact: true }).click();
  await answer.fill(String.raw`结果是 $\frac{1}{2}$。` + '\n\n版权声明：这是我自己的回答。');
  await answerEditor.getByRole('checkbox', { name: '公式排版', exact: true }).check();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await wait(
    async () => (await api('/api/attempts/' + attempt.id)).answers.MATH?.mathEnabled === true,
  );
  await page.reload();
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().click();
  await wait(async () => (await api('/api/attempts/' + attempt.id)).status === 'submitted');
  await page.getByText('参考答案与解析', { exact: true }).first().click();
  await wait(async () => (await page.locator('.exam-question .katex').count()) >= 9);
  await open('#/questions/MATH');
  await page.getByRole('button', { name: '本题的详细历史作答', exact: true }).click();
  await page.locator('.question-history-record summary').first().click();
  const historical = page.locator('.question-history-user-answer');
  await historical.getByText('版权声明：这是我自己的回答。', { exact: true }).waitFor();
  assert.equal(await historical.locator('.katex').count(), 1);
  await open('#/attempts/' + attempt.id);
  checks.push(
    'independent answer mode, draft reload, submission, references and per-question history',
  );
  await page.evaluate(() => {
    window.__mathSvg = [];
    window.__mathRasterEdges = [];
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...rest) {
      if (image instanceof HTMLImageElement && image.src.startsWith('data:image/svg+xml')) {
        window.__mathSvg.push(image.src);
        const result = draw.call(this, image, ...rest),
          { width, height } = this.canvas,
          pixels = this.getImageData(0, 0, width, height).data;
        let clipped = false;
        for (let row = 0; row < height; row++)
          for (const col of [0, 1, width - 2, width - 1]) {
            const index = (row * width + col) * 4;
            if (pixels[index] < 240 && pixels[index + 1] < 240 && pixels[index + 2] < 240)
              clipped = true;
          }
        window.__mathRasterEdges.push({ width, height, clipped });
        return result;
      }
      return draw.call(this, image, ...rest);
    };
  });
  await page.getByRole('button', { name: '导出题集', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '导出题集', exact: true });
  await dialog.getByRole('radio', { name: /附答案卷/ }).check();
  const pending = page.waitForEvent('download', { timeout: 60000 });
  await dialog.getByRole('button', { name: '下载文件', exact: true }).click();
  const downloaded = await pending;
  await downloaded.saveAs(resolve(folder, 'formula-showcase.pdf'));
  assert.ok((await stat(resolve(folder, 'formula-showcase.pdf'))).size > 1_000_000);
  const svgs = await page.evaluate(() => window.__mathSvg);
  assert.ok(svgs.length >= 7);
  for (const svg of svgs) {
    const source = decodeURIComponent(svg.slice(svg.indexOf(',') + 1));
    for (const face of source.match(/@font-face\s*\{[^}]+\}/g) || [])
      assert.match(
        face,
        /src:\s*url\(["']?data:/,
        'every raster font face must be embedded, including regular weight',
      );
  }
  assert.ok(
    (await page.evaluate(() => window.__mathRasterEdges)).every((image) => !image.clipped),
    'formula glyphs must retain the capture padding',
  );
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('actual PDF export using bundled fonts and high-DPI formula images');
  await page.setViewportSize({ width: 390, height: 844 });
  await open('#/questions/WIDE');
  await page.locator('.katex').waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
  );
  assert.ok(
    await page.locator('.formula-content').evaluate((node) => node.scrollWidth > node.clientWidth),
  );
  await page.screenshot({ path: resolve(folder, 'formula-mobile.png'), fullPage: true });
  await page.context().setOffline(true);
  assert.ok(await page.locator('.formula .katex').count());
  await page.context().setOffline(false);
  checks.push('mobile formula-only scrolling and already-loaded offline rendering');
  await open('#/questions/MATH/edit');
  await page.getByRole('button', { name: '插入公式', exact: true }).first().click();
  await page.getByRole('button', { name: '矩阵', exact: true }).click();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
  );
  await page.screenshot({ path: resolve(folder, 'formula-editor-mobile.png'), fullPage: true });
  harness.assertClean();
  await writeFile(
    resolve(folder, 'result.json'),
    JSON.stringify({ checks, external: harness.external }, null, 2),
  );
  console.log('PASS ' + checks.length + ' formula UI flows');
} catch (error) {
  await harness.captureFailure(error);
  throw error;
} finally {
  await harness.close();
}
