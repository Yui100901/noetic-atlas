/** Presence of reference material, not a second question validator. Optional
 * prose may hold both the answer and its reasoning in either field. */
export interface ReferenceSolution {
  type:string;
  answerMarkdown?:string;
  explanationMarkdown?:string;
  correctAnswers?:string[];
  blanks?:Array<{answers:string[]}>;
  parts?:ReferenceSolution[];
}
export function hasReferenceSolution(value:ReferenceSolution):boolean {
  if(value.type==='group')return !!value.parts?.length&&value.parts.every(hasReferenceSolution);
  if(['single_choice','multiple_choice','true_false'].includes(value.type))return !!value.correctAnswers?.length;
  if(value.type==='fill_blank')return !!value.blanks?.length&&value.blanks.every(blank=>blank.answers.some(answer=>!!answer.trim()));
  return !!(value.answerMarkdown?.trim()||value.explanationMarkdown?.trim());
}
