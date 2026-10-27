import {createHash} from 'node:crypto';
import type {Question,QuestionPart} from '../../../shared/models/types.js';
export function feedbackFingerprint(source:{question:Question;part?:QuestionPart}):string{
 const fields=(value:Question|QuestionPart)=>({title:value.title,type:value.type,stemMarkdown:value.stemMarkdown,answerMarkdown:value.answerMarkdown,explanationMarkdown:value.explanationMarkdown,options:value.options,correctAnswers:value.correctAnswers,blanks:value.blanks});
 const data=source.part?{material:source.question.stemMarkdown,partId:source.part.id,question:fields(source.part)}:{question:fields(source.question),parts:source.question.parts?.map(part=>({id:part.id,...fields(part)}))};
 return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
