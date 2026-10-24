import type { Question } from '../../../shared/models/types';

/** AI tools currently read the live source. Only offer them when its complete
 * learning content still matches the immutable set snapshot. */
export function matchesQuestionSnapshot(snapshot: Question, source: Question): boolean {
  const content = (question: Question) => [question.title, question.type, question.stemMarkdown, question.options, question.correctAnswers, question.blanks || [], question.parts || [], question.answerMarkdown, question.explanationMarkdown, question.sourceRefs];
  return JSON.stringify(content(snapshot)) === JSON.stringify(content(source));
}
