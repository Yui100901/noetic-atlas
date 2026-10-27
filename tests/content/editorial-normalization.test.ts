import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeBankEditorial} from '../../scripts/content/editorial-normalization.js';
import {questionSchema} from '../../server/core/validation.js';
import type {Question} from '../../shared/models/types.js';

test('old Markdown answer and embedded explanation separate losslessly and idempotently',()=>{
  const old=questionSchema.parse({id:'old',title:'概念',type:'short_answer',stemMarkdown:'解释这个概念。',answerMarkdown:'**回答：** 先给出独立的核心概念。\n\n**机制与例子：** 这里展开适用边界和反例。\n\n**误区：** 不应省略前提。'}) as Question;
  const next=normalizeBankEditorial(old);
  assert.equal(next.answerMarkdown+'\n\n'+next.explanationMarkdown,old.answerMarkdown);
  assert.deepEqual(normalizeBankEditorial(next),next);assert.equal(next.id,old.id);
  assert.equal(next.status,old.status);assert.deepEqual(next.sourceRefs,old.sourceRefs);
});
test('ordinary paragraphs, code and independently supplied explanation are never split',()=>{
  for(const [answer,explanation]of [['普通答案文本，没有明确的解释边界。',''],['**回答：** 完整答案。\n\n**追问：** 后续问题。','已经单独撰写的解析。'],['```md\n**追问：**\n```','']]){
    const old=questionSchema.parse({id:'q',type:'short_answer',title:'测试',stemMarkdown:'问题',answerMarkdown:answer,explanationMarkdown:explanation}) as Question;
    assert.deepEqual(normalizeBankEditorial(old),old);
  }
});
