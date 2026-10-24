import type { Question, VocabularyData } from '../../../shared/models/types';

/** AI tools currently read the live source. Only offer them when its complete
 * learning content still matches the immutable set snapshot. */
export function matchesQuestionSnapshot(snapshot: Question, source: Question): boolean {
  const content = (question: Question) => [question.title, question.type, question.stemMarkdown, question.options, question.correctAnswers, question.blanks || [], question.parts || [], question.answerMarkdown, question.explanationMarkdown, question.sourceRefs, question.vocabulary];
  return JSON.stringify(content(snapshot)) === JSON.stringify(content(source));
}

/** Reading-only metadata may supplement a legacy wordlist snapshot. Never
 * replace historical material, answers, word identity or an existing reading. */
export function snapshotVocabulary(snapshot:Question & {sourceQuestionId?:string;partId?:string},source?:Question):VocabularyData|undefined {
  if(snapshot.vocabulary)return snapshot.vocabulary;
  if(!source?.vocabulary||snapshot.partId||source.id!==(snapshot.sourceQuestionId||snapshot.id)||source.title!==snapshot.title||snapshot.type==='group')return undefined;
  const headword=snapshot.title.split('｜')[0]!.normalize('NFKC').trim().toLocaleLowerCase('en');
  return headword===source.vocabulary.headword.normalize('NFKC').trim().toLocaleLowerCase('en')?source.vocabulary:undefined;
}
