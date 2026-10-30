import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import { rehypeFormula } from '../../web/shared/math/rehype-formula.js';

const render = (children: string) =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children,
      remarkPlugins: [remarkMath],
      rehypePlugins: [rehypeFormula],
      skipHtml: true,
    }),
  );
test('rendering only replaces parsed math, leaving money escapes and code intact', () => {
  const html = render(
    '文字 $x_i^2$ 与金额 \\$10。`$code$`\n\n```js\nconst price="$10";\n```\n\n$$\n\\ce{H2O}\n$$',
  );
  assert.equal((html.match(/data-tex=/g) || []).length, 2);
  assert.doesNotMatch(html, /math-format-warning/);
  assert.match(html, /price=&quot;\$10&quot;/);
});
test('unclosed delimiters add a visible warning while retaining the original text', () => {
  assert.match(render('未闭合 $x+1'), /math-format-warning/);
  assert.match(render('未闭合 $x+1'), /未闭合 \$x\+1/);
  assert.match(render('$$\nx+1'), /分隔符未闭合/);
  assert.doesNotMatch(render('`$x`\n\n```js\n$notMath\n```'), /math-format-warning/);
});
test('rendering bounds formula count and retains excess source', () => {
  const html = render(Array.from({ length: 502 }, (_, index) => `$x_${index}$`).join(' '));
  assert.equal((html.match(/data-tex=/g) || []).length, 500);
  assert.match(html, /超出部分显示源码/);
  assert.match(html, /<code>x_501<\/code>/);
});
