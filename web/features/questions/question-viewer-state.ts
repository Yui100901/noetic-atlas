import type { ConceptData, Question, VocabularyData } from '../../../shared/models/types';

/** Compare content for supplementation and readers without a stored source.
 * Set AI tools use their explicit paper/version provenance instead. */
export function matchesQuestionSnapshot(snapshot: Question, source: Question): boolean {
  const content = (question: Question) => [!!question.mathEnabled, question.title, question.type, question.stemMarkdown, question.options, question.correctAnswers, question.blanks || [], question.parts || [], question.answerMarkdown, question.explanationMarkdown, question.gradingRequirements || '', question.sourceRefs, question.vocabulary, question.concept];
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

/** Concept definitions are only supplemented from an identical live source. */
export function snapshotConcept(snapshot:Question & {sourceQuestionId?:string;partId?:string},source?:Question):ConceptData|undefined {
  if(snapshot.concept)return snapshot.concept;
  return source?.concept && !snapshot.partId && source.id===(snapshot.sourceQuestionId||snapshot.id) && source.title===snapshot.title && source.stemMarkdown===snapshot.stemMarkdown ? source.concept : undefined;
}
