import test from 'node:test';
import assert from 'node:assert/strict';
import {questionEditorSignature,questionEditorSources,questionEditorValue} from '../../web/features/questions/question-editor-state.js';
import type {Question} from '../../shared/models/types.js';
import {questionSchema} from '../../server/core/validation.js';

test('editor baseline excludes private and derived state and tracks unsaved answer, option and source changes',()=>{
  const raw={...questionSchema.parse({id:'editor',title:'题目',type:'short_answer',stemMarkdown:'问题',answerMarkdown:'参考回答',sourceRefs:[{label:'原始出处',url:'https://example.org/material'}]}),id:'editor',study:{notes:'私人笔记'},partStudies:[],feedbackSummary:{suspected:true},createdAt:'2026-10-27T00:00:00Z',updatedAt:'2026-10-27T01:00:00Z'} as unknown as Question;
  const value=questionEditorValue(raw),sources=questionEditorSources(value.sourceRefs),baseline=questionEditorSignature(value,sources);
  for(const field of ['study','partStudies','feedbackSummary','createdAt','updatedAt'])assert.ok(!Object.hasOwn(value,field),field);
  assert.equal(questionEditorSignature({...value},sources),baseline);
  assert.notEqual(questionEditorSignature({...value,answerMarkdown:'修改但未保存'},sources),baseline);
  assert.notEqual(questionEditorSignature({...value,options:[{key:'A',text:'新选项'}]},sources),baseline);
  assert.notEqual(questionEditorSignature(value,sources+'\n补充出处 | https://example.org/next'),baseline);
  assert.equal(questionEditorSignature(questionEditorValue({...raw,study:{notes:'只更新笔记'}} as unknown as Question),sources),baseline);
});
