import {AI_QUESTION_EDIT_FIELDS,type AiQuestionEditChanges,type AiQuestionEditField,type AiQuestionEditSuggestion} from '../../../shared/ai/question-edit';
import type {QuestionInput,QuestionPart,QuestionType} from '../../../shared/models/types';

type Target=QuestionInput|QuestionPart;
type Values=Partial<Record<AiQuestionEditField,unknown>>;
export type AiQuestionEditFailureCode='invalid_suggestion'|'invalid_receipt'|'question_changed'|'type_changed'|'part_missing'|'field_conflict'|'no_change';
export interface AiQuestionEditFailure {ok:false;code:AiQuestionEditFailureCode;message:string;fields?:AiQuestionEditField[]}
export interface AiQuestionEditReceipt {
 suggestionId:string;questionId?:string;questionType:QuestionType;targetPartId?:string;targetType:Target['type'];
 fields:AiQuestionEditField[];before:AiQuestionEditChanges;after:AiQuestionEditChanges;
 /** Preserve optional-field absence and protect grading/taxonomy dependencies. */
 beforePresent:Partial<Record<AiQuestionEditField,boolean>>;guards:Values;
}
export type AiQuestionEditApplyResult={ok:true;value:QuestionInput;receipt:AiQuestionEditReceipt;message:string}|AiQuestionEditFailure;
export type AiQuestionEditUndoResult={ok:true;value:QuestionInput;message:string}|AiQuestionEditFailure;

const labels:Record<AiQuestionEditField,string>={title:'标题',stemMarkdown:'题干',answerMarkdown:'参考答案',explanationMarkdown:'解析',options:'选项',correctAnswers:'判分答案',blanks:'填空答案',categoryIds:'分类',tagIds:'标签'};
const gradingFields:AiQuestionEditField[]=['options','correctAnswers','blanks'];
const taxonomyFields:AiQuestionEditField[]=['categoryIds','tagIds'];
const allowed=new Set<string>(AI_QUESTION_EDIT_FIELDS);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const clone=<T,>(value:T):T=>structuredClone(value);
const has=(value:object,key:string)=>Object.hasOwn(value,key);
function same(a:unknown,b:unknown):boolean {
 if(a===b)return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((value,index)=>same(value,b[index]));
 if(!plain(a)||!plain(b))return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>has(b,key)&&same(a[key],b[key]));
}
function target(question:QuestionInput,partId?:string):Target|null {
 if(!partId)return question;
 if(question.type!=='group')return null;
 const matches=question.parts?.filter(part=>part.id===partId)||[];
 return matches.length===1?matches[0]:null;
}
const field=(value:Target,key:AiQuestionEditField):unknown=>(value as unknown as Record<string,unknown>)[key];
function failure(code:AiQuestionEditFailureCode,message:string,fields?:AiQuestionEditField[]):AiQuestionEditFailure{return{ok:false,code,message,...(fields?.length?{fields}:{})};}
function conflicts(message:string,fields:AiQuestionEditField[]):AiQuestionEditFailure{return failure('field_conflict',`${message}（${fields.map(key=>labels[key]).join('、')}）。请保留当前编辑内容并重新分析。`,fields);}
function guardsFor(fields:AiQuestionEditField[]):AiQuestionEditField[]{return[...new Set([...fields,...(fields.some(key=>gradingFields.includes(key))?gradingFields:[]),...(fields.some(key=>taxonomyFields.includes(key))?taxonomyFields:[])])];}

/** The provider already validates full question structure. Here we enforce
 * the editable boundary and JSON field shapes without a second question schema. */
function validChanges(value:unknown,partId?:string):value is AiQuestionEditChanges {
 if(!plain(value)||Object.getOwnPropertySymbols(value).length)return false;
 const fields=Object.keys(value);if(!fields.length||fields.some(key=>!allowed.has(key)))return false;
 for(const key of fields as AiQuestionEditField[]){
  const item=value[key];
  if(['title','stemMarkdown','answerMarkdown','explanationMarkdown'].includes(key)){if(typeof item!=='string')return false;}
  else if(key==='categoryIds'||key==='tagIds'||key==='correctAnswers'){if(partId&&key!=='correctAnswers'||!Array.isArray(item)||item.some(value=>typeof value!=='string'))return false;}
  else if(key==='options'){if(!Array.isArray(item)||item.some(value=>!plain(value)||Object.keys(value).some(key=>!['key','text'].includes(key))||typeof value.key!=='string'||typeof value.text!=='string'))return false;}
  else if(key==='blanks'){
   if(!Array.isArray(item)||item.some(value=>!plain(value)||Object.keys(value).some(key=>!['id','label','answers','caseSensitive','trim'].includes(key))||typeof value.id!=='string'||typeof value.label!=='string'||!Array.isArray(value.answers)||value.answers.some(answer=>typeof answer!=='string')||typeof value.caseSensitive!=='boolean'||typeof value.trim!=='boolean'))return false;
  }
 }
 return true;
}
function identity(current:QuestionInput,questionId:string|undefined,questionType:QuestionType,partId?:string,targetType?:Target['type']):AiQuestionEditFailure|null {
 if(current.id!==questionId)return failure('question_changed','当前题目已切换，请重新分析后再使用建议。');
 if(current.type!==questionType)return failure('type_changed','题型已改变，请重新分析当前题型。');
 const currentTarget=target(current,partId);
 if(!currentTarget)return failure('part_missing','该小题已删除或身份发生变化，请重新分析。');
 if(targetType!==undefined&&currentTarget.type!==targetType)return failure('type_changed','该小题的题型已改变，请重新分析。');
 return null;
}
function replaceTarget(current:QuestionInput,partId:string|undefined,changes:Values,remove:AiQuestionEditField[]=[]):QuestionInput {
 const original=target(current,partId)!;
 const changed:Record<string,unknown>={...original};
 for(const [key,value]of Object.entries(changes))changed[key]=clone(value);
 for(const key of remove)delete changed[key];
 return partId?{...current,parts:current.parts!.map(part=>part.id===partId?changed as unknown as QuestionPart:part)}:changed as unknown as QuestionInput;
}

/** Apply exactly one proposal to the editor, never to a persisted record. */
export function applyAiQuestionEditSuggestion(current:QuestionInput,baseline:QuestionInput,suggestion:AiQuestionEditSuggestion):AiQuestionEditApplyResult {
 try{
  if(!suggestion||typeof suggestion.id!=='string'||!suggestion.id||suggestion.partId!==undefined&&(typeof suggestion.partId!=='string'||!suggestion.partId)||!validChanges(suggestion.changes,suggestion.partId))return failure('invalid_suggestion','建议包含不支持的修改字段或无效内容，未应用任何修改。');
  const baseTarget=target(baseline,suggestion.partId);
  if(!baseTarget)return failure('part_missing','分析快照中没有这个小题，请重新分析。');
  const blocked=identity(current,baseline.id,baseline.type,suggestion.partId,baseTarget.type);if(blocked)return blocked;
  const currentTarget=target(current,suggestion.partId)!;
  // Ignore model no-ops rather than claiming ownership of untouched fields.
  const fields=(Object.keys(suggestion.changes) as AiQuestionEditField[]).filter(key=>!same(field(baseTarget,key),suggestion.changes[key]));
  if(!fields.length)return failure('no_change','这条建议与分析时的内容相同，无需应用。');
  const guardFields=guardsFor(fields),changed=guardFields.filter(key=>!same(field(currentTarget,key),field(baseTarget,key)));
  if(changed.length)return conflicts('相关字段已在分析后修改，不能覆盖当前内容',changed);
  const before:Values={},after:Values={},beforePresent:AiQuestionEditReceipt['beforePresent']={};
  for(const key of fields){before[key]=clone(field(currentTarget,key));after[key]=clone(suggestion.changes[key]);beforePresent[key]=has(currentTarget,key);}
  const value=replaceTarget(current,suggestion.partId,after),appliedTarget=target(value,suggestion.partId)!,guards:Values={};
  for(const key of guardFields)guards[key]=clone(field(appliedTarget,key));
  const receipt:AiQuestionEditReceipt={suggestionId:suggestion.id,questionId:current.id,questionType:current.type,targetPartId:suggestion.partId,targetType:currentTarget.type,fields:[...fields],before:before as AiQuestionEditChanges,after:after as AiQuestionEditChanges,beforePresent,guards};
  return{ok:true,value,receipt,message:'已应用到当前编辑内容，请核对后保存题目。'};
 }catch{return failure('invalid_suggestion','未能安全应用这条建议，当前编辑内容保持不变。');}
}

/** Undo only this proposal's still-current fields. A saved proposal can be
 * undone into a new unsaved edit; no database rollback is implied. */
export function undoAiQuestionEditSuggestion(current:QuestionInput,receipt:AiQuestionEditReceipt):AiQuestionEditUndoResult {
 try{
  if(!receipt||!Array.isArray(receipt.fields)||!receipt.fields.length||receipt.fields.some(key=>!allowed.has(key))||new Set(receipt.fields).size!==receipt.fields.length||!plain(receipt.before)||!plain(receipt.after)||!plain(receipt.beforePresent)||!plain(receipt.guards))return failure('invalid_receipt','撤回记录不完整，未修改当前内容。');
  const blocked=identity(current,receipt.questionId,receipt.questionType,receipt.targetPartId,receipt.targetType);if(blocked)return blocked;
  if(receipt.targetPartId&&receipt.fields.some(key=>key==='categoryIds'||key==='tagIds'))return failure('invalid_receipt','小题撤回记录包含不支持的归类字段。');
  const guardFields=guardsFor(receipt.fields);
  if(receipt.fields.some(key=>!has(receipt.before,key)||!has(receipt.after,key)||typeof receipt.beforePresent[key]!=='boolean')||guardFields.some(key=>!has(receipt.guards,key))||Object.keys(receipt.before).some(key=>!receipt.fields.includes(key as AiQuestionEditField))||Object.keys(receipt.after).some(key=>!receipt.fields.includes(key as AiQuestionEditField))||Object.keys(receipt.guards).some(key=>!guardFields.includes(key as AiQuestionEditField)))return failure('invalid_receipt','撤回记录不完整，未修改当前内容。');
  const currentTarget=target(current,receipt.targetPartId)!;
  const changed=guardFields.filter(key=>!same(field(currentTarget,key),receipt.guards[key]));
  if(changed.length)return conflicts('建议应用后相关字段又被修改，无法安全撤回',changed);
  const value=replaceTarget(current,receipt.targetPartId,receipt.before,receipt.fields.filter(key=>!receipt.beforePresent[key]));
  return{ok:true,value,message:'已撤回本条建议。若题目已保存，请再次保存以保留此次撤回。'};
 }catch{return failure('invalid_receipt','未能安全撤回这条建议，当前编辑内容保持不变。');}
}
