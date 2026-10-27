import type { Question } from '../../../shared/models/types.js';
import { conceptPromptIsSafe } from '../../../shared/questions/concept.js';
import type { Store } from '../../core/store.js';
import { fail } from '../../core/validation.js';

export function isConceptQuestion(question: Question): boolean {
  return question.type === 'short_answer' && !!question.concept && conceptPromptIsSafe(question.concept);
}
export function resolveConceptQuestion(store: Store, question: Question): Question {
  if (isConceptQuestion(question)) return question;
  const source = store.get<Question>('questions', question.id);
  if (!question.concept && question.type === 'short_answer' && source && source.title === question.title && source.stemMarkdown === question.stemMarkdown && isConceptQuestion(source)) return { ...question, concept: source.concept };
  return fail(400, 'CONCEPT_CARD_REQUIRED', `概念题集只可包含带有安全独立定义的概念简答卡：${question.title}`);
}
export function validateConceptPaperSnapshot(questions: Question[]): void {
  if (!questions.length || questions.some(question => !isConceptQuestion(question))) fail(400, 'INVALID_CONCEPT_PAPER', '概念题集须全部为带有独立定义、主概念与可接受别称的简答卡');
}
export function forwardConceptQuestion(question: Question): Question {
  if (!isConceptQuestion(question)) fail(400, 'CONCEPT_CARD_REQUIRED', '本题没有安全的结构化概念信息');
  return { ...question, title: question.concept!.term, stemMarkdown: `请解释以下概念的含义。\n\n**${question.concept!.term}**` };
}
export function reverseConceptQuestion(question: Question): Question {
  if (!isConceptQuestion(question)) fail(400, 'CONCEPT_CARD_REQUIRED', '概念缺少安全独立定义，不能进行逆向练习');
  const value = question.concept!;
  return { ...question, title: '看描述想概念', type: 'fill_blank', stemMarkdown: `根据以下独立描述回忆对应概念。\n\n${value.meaningPrompt}\n\n请填写概念名称；答案按本卡所列主词与别称核对。`, options: [], correctAnswers: [], parts: undefined,
    blanks: [{ id: 'concept', label: '概念名称', answers: [...value.acceptedAnswers], caseSensitive: false, trim: true }], answerMarkdown: `**目标概念**：${value.term}\n\n${question.answerMarkdown}` };
}
