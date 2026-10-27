import test from 'node:test';
import assert from 'node:assert/strict';
import {appendChoiceOption,removeChoiceOption,renumberChoiceOptions} from '../../shared/questions/choice-options.js';
import type {QuestionPart} from '../../shared/models/types.js';

const options=()=>['A','B','C','D'].map(key=>({key,text:'原选项'+key}));

test('deleting C relabels old D as C while keeping its selected identity and source immutable',()=>{
  const content={options:options(),correctAnswers:['D']},original=structuredClone(content);
  const next=removeChoiceOption(content,'C');
  assert.deepEqual(next.options,[{key:'A',text:'原选项A'},{key:'B',text:'原选项B'},{key:'C',text:'原选项D'}]);
  assert.deepEqual(next.correctAnswers,['C']);assert.deepEqual(content,original);
  assert.ok(next.options.every((option,index)=>option!==content.options[index]));
});
test('deleting a correct answer clears that choice rather than selecting the option that inherits its label',()=>{
  assert.deepEqual(removeChoiceOption({options:options(),correctAnswers:['C']},'C').correctAnswers,[]);
  assert.deepEqual(removeChoiceOption({options:options(),correctAnswers:['A','C','D']},'C').correctAnswers,['A','C']);
  const after=removeChoiceOption({options:options(),correctAnswers:['B','D']},'A');
  assert.deepEqual(after.correctAnswers,['A','C']);assert.equal(after.options[0].text,'原选项B');
});
test('append follows current display order, including older noncontiguous keys, without moving correct content',()=>{
  const content={options:[{key:'B',text:'旧B'},{key:'D',text:'旧D'}],correctAnswers:['D']};
  const next=appendChoiceOption(content);
  assert.deepEqual(next.options,[{key:'A',text:'旧B'},{key:'B',text:'旧D'},{key:'C',text:''}]);
  assert.deepEqual(next.correctAnswers,['B']);
  const afterRemoval=appendChoiceOption(removeChoiceOption({options:options(),correctAnswers:['D']},'C'));
  assert.deepEqual(afterRemoval.options.map(option=>option.key),['A','B','C','D']);
  assert.deepEqual(afterRemoval.correctAnswers,['C']);assert.equal(afterRemoval.options[3].text,'');
});
test('normalization maps by identity rather than text, removes orphan answer keys and caps at Z',()=>{
  assert.deepEqual(renumberChoiceOptions([{key:'x',text:'相同'},{key:'y',text:'相同'}],['y','missing','y']).correctAnswers,['B']);
  const all={options:'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(key=>({key,text:key})),correctAnswers:['Z']};
  assert.deepEqual(appendChoiceOption(all),all);
  assert.throws(()=>renumberChoiceOptions([...all.options,{key:'27',text:''}],[]),RangeError);
  assert.throws(()=>renumberChoiceOptions([{key:'A',text:'1'},{key:'A',text:'2'}],['A']),/重复标号/);
});
test('same transformation updates a group leaf without changing its question fields or siblings',()=>{
  const part={id:'p1',title:'组合小题',type:'multiple_choice',stemMarkdown:'选择正确项目。',answerMarkdown:'旧解析正文保持原样。',explanationMarkdown:'需在编辑时自行核对正文所提选项字母。',options:options(),correctAnswers:['B','D'],weight:2} satisfies QuestionPart;
  const sibling={...part,id:'p2'},parts=[part,sibling];
  const changed=parts.map(item=>item.id==='p1'?{...item,...removeChoiceOption(item,'B')}:item);
  assert.deepEqual(changed[0].correctAnswers,['C']);assert.equal(changed[0].options[2].text,'原选项D');
  assert.equal(changed[0].answerMarkdown,part.answerMarkdown);assert.equal(changed[0].weight,2);assert.equal(changed[1],sibling);assert.deepEqual(part.correctAnswers,['B','D']);
});
