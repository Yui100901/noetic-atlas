import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRubricFormat } from '../../scripts/content/rubric-format.js';

const codes = (source: string) => inspectRubricFormat(source).map((issue) => issue.code);

test('rubric format gate catches actual empty numbered or bullet items and unnamed nested lists', () => {
  assert.ok(codes('### 必要核对点\n1.\n2. 有文字').includes('empty_list_item'));
  assert.ok(codes('### 必要核对点\n1. - a + 单数可数名词').includes('unlabelled_nested_list'));
  assert.ok(codes('### 必要核对点\n1. - 第一项\n   - 第二项').includes('unlabelled_nested_list'));
  assert.deepEqual(
    inspectRubricFormat('1. 核对主词\n   - 允许别称甲\n   - 允许别称乙\n2. 核对区别'),
    [],
  );
});

test('a generated unindented code point cannot silently swallow the rest of the rubric', () => {
  const malformed =
    '1. 核对算法\n2. ```text\nseen = {}\nreturn seen\n```\n\n### 判定\n核心条件错误不能判对。';
  assert.ok(codes(malformed).includes('unclosed_fence'));
  assert.deepEqual(
    inspectRubricFormat(
      '1. 核对算法\n2. ```text\n   seen = {}\n   return seen\n   ```\n\n### 判定\n核对返回值。',
    ),
    [],
  );
  assert.deepEqual(
    inspectRubricFormat(
      '1. 核对算法\n\n```text\nseen = {}\nreturn seen\n```\n\n### 判定\n核对返回值。',
    ),
    [],
  );
});

test('punctuation placeholders and detached value labels are rejected without confusing code, tables or mathematics', () => {
  assert.ok(codes('1. 拼音：huànnànyǔgòng\n2. ...').includes('punctuation_only_prose'));
  assert.ok(codes('1. 词性：\n2. 动词').includes('empty_label'));
  assert.ok(codes('1. 中文释义：').includes('empty_label'));
  assert.deepEqual(
    inspectRubricFormat(
      '1. 标识符必须是 `...`，不是 `..`。\n2. $+$ 与 $-$ 的作用不同。\n\n| 记号 | 意义 |\n| --- | --- |\n| ... | 可变参数 |\n| ; | 结束符 |\n\n```text\n...\n1.\n词性：\n```',
    ),
    [],
  );
  assert.deepEqual(
    inspectRubricFormat('$$\n\\sum_{n=1}^{\\infty} a_n\\cdots\n$$\n\n+1 与 -1 必须区分。'),
    [],
  );
});

test('blank optional rubrics and valid numbered continuations are not new quality errors', () => {
  assert.deepEqual(inspectRubricFormat(''), []);
  assert.deepEqual(inspectRubricFormat('  \n\t'), []);
  assert.deepEqual(
    inspectRubricFormat(
      '1. 定义必须包含范围条件。\n   条件为正数时适用。\n2. 说明反例。\n\n   > 反例不能省略条件。',
    ),
    [],
  );
});

test('generic type syntax cannot be silently hidden as raw HTML while escaped or code forms retain their meaning', () => {
  assert.ok(codes('1. List<Integer>不能赋给List<Number>。').includes('hidden_html'));
  assert.ok(
    codes('| 类型 | 要点 |\n| --- | --- |\n| <T> | 隐藏的类型参数 |').includes('hidden_html'),
  );
  assert.deepEqual(
    inspectRubricFormat(
      '1. `List<Integer>`不能赋给`List<Number>`。\n2. List&lt;Integer&gt; 与 List&lt;Number&gt; 的类型实参不同。\n\n| 类型 | 要点 |\n| --- | --- |\n| `<T>` | 显示参数 |',
    ),
    [],
  );
});
