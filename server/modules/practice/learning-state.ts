import type { Question, QuestionType } from '../../../shared/models/types.js';
import { isAnswerPresent } from '../../../shared/practice/attempt-timing.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { LEGACY_POINTS } from './scoring.js';

export interface LearningJudgingItem {
  id: string; type: QuestionType; sourceQuestionId?: string | null;
  correctAnswers?: string[]; blanks?: Question['blanks'];
  answerValue?: string | string[] | null; selfScore?: number | null;
  scoringEnabled?: boolean | number; maximumPoints?: number | null;
}
export const learningQuestionKey=(sourceId:string,leafId:string)=>JSON.stringify([sourceId,leafId]);
/** Missing subjective grades are deliberately absent judgments. */
export function learningJudgment(item:LearningJudgingItem):{wrong:boolean;answerState?:'incorrect'|'unanswered'}|undefined {
  if(isSubjectiveType(item.type)){
    if(!item.scoringEnabled||item.selfScore==null)return;
    const wrong=item.selfScore<(item.maximumPoints??LEGACY_POINTS[item.type]);
    return {wrong,...(wrong?{answerState:'incorrect' as const}:{})};
  }
  const answer={value:item.answerValue??''},wrong=!getObjectiveCorrect(item,answer);
  return {wrong,...(wrong?{answerState:isAnswerPresent(answer)?'incorrect' as const:'unanswered' as const}:{})};
}
