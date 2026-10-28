import type {QuestionInput} from '../models/types.js';

export const AI_QUESTION_EDIT_FIELDS = ['title','stemMarkdown','answerMarkdown','explanationMarkdown','options','correctAnswers','blanks','categoryIds','tagIds'] as const;
export type AiQuestionEditField=typeof AI_QUESTION_EDIT_FIELDS[number];
export type AiQuestionEditChanges=Partial<Pick<QuestionInput,AiQuestionEditField>>;
export interface AiQuestionEditSuggestion {
 id:string;title:string;reason:string;confidence:'high'|'medium'|'low';partId?:string;changes:AiQuestionEditChanges;
}
export interface AiQuestionEditResult {summary:string;suggestions:AiQuestionEditSuggestion[];warnings:string[]}
export interface AiQuestionEditInput {questionId:string;expectedUpdatedAt:string;question:QuestionInput;requirements?:string}
