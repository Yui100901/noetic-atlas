import type { AnswerVerdict, Question, QuestionType } from '../../../shared/models/types.js';
import { isAnswerPresent } from '../../../shared/practice/attempt-timing.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { LEGACY_POINTS } from './scoring.js';

export interface LearningJudgingItem {
  id: string; type: QuestionType; sourceQuestionId?: string | null; partId?: string | null;
  correctAnswers?: string[]; blanks?: Question['blanks'];
  answerValue?: string | string[] | null; selfScore?: number | null;
  scoringEnabled?: boolean | number; maximumPoints?: number | null;
  verdict?: AnswerVerdict | null;
}
export const learningQuestionKey=(sourceId:string,leafId:string)=>JSON.stringify([sourceId,leafId]);
/** Missing subjective grades are deliberately absent judgments. */
export function learningJudgment(item:LearningJudgingItem):{wrong:boolean;answerState?:'incorrect'|'unanswered';verdict?:AnswerVerdict}|undefined {
  if(isSubjectiveType(item.type)){
    const verdict=item.scoringEnabled&&item.selfScore!=null?(item.selfScore>=(item.maximumPoints??LEGACY_POINTS[item.type])?'correct':item.selfScore>0?'partial':'incorrect'):item.verdict;
    if(!verdict)return;
    const wrong=verdict!=='correct';
    return {wrong,verdict,...(wrong?{answerState:'incorrect' as const}:{})};
  }
  const answer={value:item.answerValue??''},wrong=!getObjectiveCorrect(item,answer);
  return {wrong,...(wrong?{answerState:isAnswerPresent(answer)?'incorrect' as const:'unanswered' as const}:{})};
}
