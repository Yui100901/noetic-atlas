import test from 'node:test';
import assert from 'node:assert/strict';
import { BLANK_LINE, findBlankMarkers, normalizeBlankMarkers, normalizeQuestionBlankStems, questionStemMarkdown } from '../../shared/questions/blank-markers.js';

test('known fill placeholders become visible lines, including numbered and spaced markers',()=>{
  const input='相对赤道南北角位置的坐标名称是{{answer}}。\n{{ blank_1 }} / {{ANSWER:2}} / {{blank 3}}';
  assert.equal(findBlankMarkers(input).length,4);
  assert.equal(normalizeBlankMarkers(input),`相对赤道南北角位置的坐标名称是${BLANK_LINE}。\n${BLANK_LINE} / ${BLANK_LINE} / ${BLANK_LINE}`);
  assert.equal(normalizeBlankMarkers(normalizeBlankMarkers(input)),normalizeBlankMarkers(input));
});
test('code, escaped literals and arbitrary templates remain unchanged',()=>{
  const input='`{{answer}}`\n\n```js\nconst template="{{answer}}";\n```\n\n    {{answer}}\n\n<code>{{answer}}</code> <pre>{{blank}}</pre> \\{{answer}} {{user}} {{unknown}}';
  assert.deepEqual(findBlankMarkers(input),[]);
  assert.equal(normalizeBlankMarkers(input),input);
  assert.equal(questionStemMarkdown({type:'short_answer',stemMarkdown:'解释 {{answer}} 模板'}),'解释 {{answer}} 模板');
});
test('group parts normalize independently without changing answers or other fields',()=>{
  const q={type:'group',stemMarkdown:'公共代码 {{answer}}',answerMarkdown:'{{answer}}',parts:[{id:'a',type:'fill_blank',stemMarkdown:'名称{{answer}}',answerMarkdown:'纬度'},{id:'b',type:'short_answer',stemMarkdown:'解释 {{answer}}'}]};
  const result=normalizeQuestionBlankStems(q);
  assert.equal(result.stemMarkdown,q.stemMarkdown);assert.equal(result.answerMarkdown,q.answerMarkdown);
  assert.equal(result.parts[0].stemMarkdown,'名称'+BLANK_LINE);assert.equal(result.parts[0].answerMarkdown,'纬度');
  assert.equal(result.parts[1],q.parts[1]);assert.equal(q.parts[0].stemMarkdown,'名称{{answer}}');
});
