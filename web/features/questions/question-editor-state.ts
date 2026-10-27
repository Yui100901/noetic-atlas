import type {Question,QuestionInput} from '../../../shared/models/types';

/** Editing never submits learning state or derived quality/feedback badges. */
export function questionEditorValue(question:Question):QuestionInput {
  const {study:_study,partStudies:_parts,feedbackSummary:_feedback,createdAt:_created,updatedAt:_updated,...value}=question;
  return value;
}
export const questionEditorSources=(sources:QuestionInput['sourceRefs'])=>sources.map(source=>`${source.label} | ${source.url}`).join('\n');
export const questionEditorSignature=(value:QuestionInput,sources:string)=>JSON.stringify([value,sources]);
