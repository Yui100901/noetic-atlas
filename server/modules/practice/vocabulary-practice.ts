import type { Question } from '../../../shared/models/types.js';
import { vocabularyPromptIsSafe } from '../../../shared/questions/vocabulary.js';
import { fail } from '../../core/validation.js';
import type { Store } from '../../core/store.js';

export function isVocabularyQuestion(question: Question): boolean {
  return question.type === 'short_answer' && !!question.vocabulary && vocabularyPromptIsSafe(question.vocabulary);
}

/** A saved wordlist may predate structured pronunciation metadata. Only borrow
 * metadata when the live source still denotes exactly the same word. */
export function resolveVocabularyQuestion(store: Store, snapshot: Question): Question {
  if (snapshot.type !== 'short_answer') fail(400, 'INVALID_VOCABULARY_CARD', `词汇题集只能包含词汇简答卡，不能混入语法或其他题型：${snapshot.title}`);
  if (snapshot.vocabulary) {
    if (!vocabularyPromptIsSafe(snapshot.vocabulary)) fail(400, 'VOCABULARY_HINT_UNSAFE', `词卡的独立释义提示含答案或格式无效：${snapshot.title}`);
    return snapshot;
  }
  const source = store.get<Question>('questions', snapshot.id);
  const titleHeadword = snapshot.title.replace(/｜日语单词$/, '').normalize('NFKC').trim().toLocaleLowerCase('en');
  if (!source || source.id !== snapshot.id || source.title !== snapshot.title || !isVocabularyQuestion(source) || titleHeadword !== source.vocabulary!.headword.normalize('NFKC').trim().toLocaleLowerCase('en')) fail(400, 'VOCABULARY_REQUIRED', `题目缺少可用的词汇信息，请仅选择词卡或先补充词汇信息：${snapshot.title}`);
  return { ...snapshot, vocabulary: source!.vocabulary };
}

/** Imports may preserve old snapshots awaiting safe live-source metadata. New
 * authoring and new sessions use resolveVocabularyQuestion for full validation. */
export function validateVocabularyPaperSnapshot(questions: Question[], allowMissingMetadata = false): void {
  if (!questions.length) fail(400, 'EMPTY_VOCABULARY_PAPER', '词汇题集至少需要一张词卡');
  for (const question of questions) {
    if (question.type !== 'short_answer' || (!question.vocabulary && !allowMissingMetadata)) fail(400, 'INVALID_VOCABULARY_CARD', `词汇题集只能包含带词汇信息的简答卡：${question.title}`);
    if (question.vocabulary && !vocabularyPromptIsSafe(question.vocabulary)) fail(400, 'VOCABULARY_HINT_UNSAFE', `词卡独立释义提示含答案或格式无效：${question.title}`);
  }
}

export function reverseVocabularyQuestion(question: Question): Question {
  const vocabulary=question.vocabulary;
  if(!vocabulary||question.type==='group')fail(400,'VOCABULARY_REQUIRED','本题没有可用的结构化词汇信息');
  if(!vocabularyPromptIsSafe(vocabulary!))fail(400,'VOCABULARY_HINT_UNSAFE','本词卡的独立释义提示不足或含答案，请先修订释义提示');
  return {...question,title:'看释义想单词',type:'fill_blank',stemMarkdown:`根据以下独立释义回忆原词卡中的词语。\n\n${vocabulary!.meaningPrompt}\n\n请填写词语。核对采用本卡收录的词形，其他同义表达可在解析中自行辨析。`,options:[],correctAnswers:[],parts:undefined,blanks:[{id:'word',label:'词语',answers:[...vocabulary!.acceptedAnswers],caseSensitive:false,trim:true}],answerMarkdown:`**目标词语**：${vocabulary!.headword}\n\n${question.answerMarkdown}`,vocabulary};
}
