import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMarkdownAction as edit, insertMarkdownText } from '../../web/shared/lib/markdown-authoring.js';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

test('inline tools format the selected text and toggle without replacing surrounding content', () => {
  const result = edit('前文内容后文', 2, 4, 'bold');
  assert.equal(result.value, '前文**内容**后文'); assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), '内容');
  assert.equal(edit(result.value, result.selectionStart, result.selectionEnd, 'bold').value, '前文内容后文');
  assert.equal(edit('**内容**', 2, 4, 'italic').value, '***内容***');
  const empty = edit('左右', 1, 1, 'strike'); assert.equal(empty.value, '左~~删除文字~~右'); assert.equal(empty.value.slice(empty.selectionStart, empty.selectionEnd), '删除文字');
});

test('line tools apply to complete selected lines but exclude the following unselected line', () => {
  const source = '甲\n乙\n丙', result = edit(source, 0, 4, 'unordered-list');
  assert.equal(result.value, '- 甲\n- 乙\n丙'); assert.equal(result.value[result.selectionEnd], '丙');
  assert.equal(edit(result.value, 0, result.selectionEnd, 'unordered-list').value, source);
  assert.equal(edit('第一项\n第二项', 0, 7, 'ordered-list').value, '1. 第一项\n2. 第二项');
  assert.equal(edit('- 原列表\n- 下一项', 0, 11, 'task-list').value, '- [ ] 原列表\n- [ ] 下一项');
  assert.equal(edit('-  [ ] task', 0, 11, 'unordered-list').value, '- task');
  assert.equal(edit('  \n- 内容', 0, 7, 'unordered-list').value, '  \n内容');
});

test('rendered emphasis and code preserve meaningful selected text around spaces', () => {
  const parser = unified().use(remarkParse).use(remarkGfm);
  for (const [action, nodeType] of [['bold', 'strong'], ['italic', 'emphasis'], ['strike', 'delete']] as const) {
    const result = edit(' hello ', 0, 7, action);
    const paragraph = parser.parse(result.value).children[0] as any;
    assert.ok(paragraph.children.some((node: any) => node.type === nodeType && node.children[0].value === 'hello'));
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), 'hello');
  }
  for (const code of [' a ', ' a`b ', '`a`', '   ']) {
    const result = edit(code, 0, code.length, 'code');
    const paragraph = parser.parse(result.value).children[0] as any;
    assert.equal(paragraph.children[0].type, 'inlineCode'); assert.equal(paragraph.children[0].value, code);
  }
});

test('heading and quote preserve indentation, caret placement and empty-line placeholders', () => {
  const result = edit('  内容', 3, 3, 'heading'); assert.equal(result.value, '  ## 内容'); assert.equal(result.selectionStart, result.selectionEnd); assert.equal(result.selectionStart, 6);
  assert.equal(edit('### 旧标题', 5, 5, 'heading').value, '## 旧标题');
  const quote = edit('', 0, 0, 'quote'); assert.equal(quote.value, '> 引用内容'); assert.equal(quote.value.slice(quote.selectionStart, quote.selectionEnd), '引用内容');
  assert.equal(edit('> 引用', 2, 4, 'quote').value, '引用');
});

test('code tools choose delimiters that cannot terminate the selected code', () => {
  assert.equal(edit('a`b', 0, 3, 'code').value, '``a`b``');
  const code = edit('前文```示例```后文', 2, 10, 'code-block');
  assert.ok(code.value.includes('\n\n````\n')); assert.ok(code.value.includes('\n````\n\n'));
  assert.equal(code.value.slice(code.selectionStart, code.selectionEnd), '```示例```');
  const long = '`a'.repeat(150000);
  for (const action of ['code', 'code-block'] as const) {
    const result = edit(long, 0, long.length, action);
    assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), long);
  }
});

test('links retain selected labels, select a destination to replace, and support selected URLs', () => {
  const link = edit('前链接后', 1, 3, 'link'); assert.equal(link.value, '前[链接](https://example.com)后'); assert.equal(link.value.slice(link.selectionStart, link.selectionEnd), 'https://example.com');
  const url = edit('https://example.com', 0, 19, 'link'); assert.equal(url.value, '[链接文字](https://example.com)'); assert.equal(url.value.slice(url.selectionStart, url.selectionEnd), '链接文字');
});

test('tables and separators form their own blocks, and image insertion honors the current selection', () => {
  const table = edit('前后', 1, 1, 'table'); assert.ok(table.value.startsWith('前\n\n|')); assert.ok(table.value.endsWith('\n\n后')); assert.equal(table.value.slice(table.selectionStart, table.selectionEnd), '列1');
  assert.ok(edit('甲\t乙\n丙\t丁', 0, 7, 'table').value.includes('| 甲 | 乙 |\n| 丙 | 丁 |'));
  assert.equal(edit('前\n后', 2, 2, 'rule').value, '前\n\n---\n\n后');
  assert.equal(edit('保留这段', 0, 4, 'rule').value, '---\n\n保留这段');
  const rule = edit('', 0, 0, 'rule'); assert.equal(rule.selectionStart, rule.value.length);
  const image = insertMarkdownText('首选区尾', 1, 3, '![图](asset://test)'); assert.equal(image.value, '首![图](asset://test)尾'); assert.equal(image.selectionStart, image.selectionEnd);
});

test('textarea UTF-16 positions, reversed selections and out-of-range offsets remain valid', () => {
  const result = edit('😀中文', 4, 2, 'bold'); assert.equal(result.value, '😀**中文**');
  assert.equal(insertMarkdownText('内容', -5, 999, '替换').value, '替换');
  for (const action of ['heading', 'bold', 'italic', 'strike', 'quote', 'code', 'code-block', 'link', 'unordered-list', 'ordered-list', 'task-list', 'table', 'rule'] as const) {
    const result = edit('', 0, 0, action); assert.ok(result.selectionStart >= 0 && result.selectionStart <= result.selectionEnd && result.selectionEnd <= result.value.length);
  }
});
