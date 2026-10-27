import type { QuestionInput, QuestionType } from '../models/types.js';
import type { AiImportMode } from './ai.js';

/** Saved only after explicit confirmation. Source text stays private to this job. */
export const AI_DOCUMENT_LIMITS = { maxSourceBytes: 12_000_000, maxSourceCharacters: 4_000_000, maxBlocks: 600, blockCharacters: 12_000, blockBytes: 45_000, maxBlocksPerRequest: 5, maxQuestionsPerBlock: 50, maxQuestionsPerJob: 2000 } as const;
export type AiDocumentBlockStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface AiDocumentFailure { code: string; message: string; stage: 'plan' | 'generate'; retryable: boolean; auditId?: string }
export interface AiDocumentSectionInput { text: string; label?: string; sourceName?: string; pageStart?: number; pageEnd?: number }
export interface AiDocumentJobInput {
  confirmed: true; sourceName: string; sourceUrl?: string; sections: AiDocumentSectionInput[];
  mode?: AiImportMode; requirements?: string; questionTypes?: QuestionType[]; difficulty?: number;
  categoryIds?: string[]; tagIds?: string[]; questionsPerBlock?: number; maxQuestions?: number;
}
export interface AiDocumentBlock {
  id: string; sourceName: string; label: string; pageStart?: number; pageEnd?: number; characters: number;
  title: string; summary: string; topics: string[];
  planStatus: AiDocumentBlockStatus; generationStatus: AiDocumentBlockStatus;
  planAttempts: number; generationAttempts: number; planFailure?: AiDocumentFailure; generationFailure?: AiDocumentFailure;
  questions: QuestionInput[]; importedQuestionIds: string[]; planRunId?: string; generationRunId?: string; generationQuestionLimit?: number;
}
export interface AiDocumentJobSummary {
  id: string; sourceName: string; sourceUrl?: string; createdAt: string; updatedAt: string;
  status: 'pending' | 'running' | 'ready' | 'partial' | 'failed' | 'completed';
  blockCount: number; plannedBlocks: number; failedBlocks: number; generatedBlocks: number; questionCount: number; importedCount: number;
}
export interface AiDocumentJob extends AiDocumentJobSummary {
  mode: AiImportMode; requirements: string; questionTypes: QuestionType[]; difficulty?: number;
  categoryIds: string[]; tagIds: string[]; questionsPerBlock: number; maxQuestions: number; blocks: AiDocumentBlock[];
}
export interface AiDocumentProcessInput { blockIds: string[]; retryFailed?: boolean; questionsPerBlock?: number }
export interface AiDocumentImportInput { confirmed: true; blockIds: string[]; questions?: Array<{ blockId: string; questions: QuestionInput[] }> }
export interface AiDocumentImportResult { added: number; items: QuestionInput[]; job: AiDocumentJob }
