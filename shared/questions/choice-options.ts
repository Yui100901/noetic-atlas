import type {Option} from '../models/types.js';

export interface ChoiceOptions {
  options: readonly Option[];
  correctAnswers: readonly string[];
}
export interface NumberedChoiceOptions {
  options: Option[];
  correctAnswers: string[];
}
const labels='ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Relabel in display order, mapping answers from the OLD identity before any
 * key changes. In particular, removing correct C must never select old D when
 * it becomes the new C. This works identically for root questions and parts. */
export function renumberChoiceOptions(options:readonly Option[],correctAnswers:readonly string[]):NumberedChoiceOptions {
  if(options.length>labels.length)throw new RangeError('选择题最多支持26个选项');
  if(new Set(options.map(option=>option.key)).size!==options.length)throw new Error('不能重编号具有重复标号的选项');
  const correct=new Set(correctAnswers);
  return {
    options:options.map((option,index)=>({...option,key:labels[index]!})),
    correctAnswers:options.flatMap((option,index)=>correct.has(option.key)?[labels[index]!]:[]),
  };
}

export function removeChoiceOption(content:ChoiceOptions,key:string):NumberedChoiceOptions {
  return renumberChoiceOptions(content.options.filter(option=>option.key!==key),content.correctAnswers);
}

export function appendChoiceOption(content:ChoiceOptions,text=''):NumberedChoiceOptions {
  const numbered=renumberChoiceOptions(content.options,content.correctAnswers);
  if(numbered.options.length===labels.length)return numbered;
  return {...numbered,options:[...numbered.options,{key:labels[numbered.options.length]!,text}]};
}
