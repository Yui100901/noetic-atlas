import type { Question, QuestionType } from './types.js';

export interface SimilarQuestionItem { question: Question; reason: string; score: number }
export interface SimilarQuestionsResponse {
  items: SimilarQuestionItem[]; total: number; page: number; pageSize: number; query: string; scope: string;
}
export interface AiSimilarQuestionsResult {
  items: { questionId: string; reason: string }[];
  candidates: { id: string; title: string; type: QuestionType }[];
  scope: string;
}
