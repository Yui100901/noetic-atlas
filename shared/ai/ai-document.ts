import type { QuestionInput, QuestionType } from '../models/types.js';
import type { AiImportMode } from './ai.js';
import type { DocumentCitation } from '../models/document-citations.js';
import { AI_IMPORT_HARD_LIMITS } from './import-limits.js';

/** Saved only after explicit confirmation. Source text stays private to this job. */
export const AI_DOCUMENT_LIMITS = {
  maxSourceBytes: AI_IMPORT_HARD_LIMITS.sourceMiB * 1024 * 1024,
  maxSourceCharacters: AI_IMPORT_HARD_LIMITS.sourceCharacters,
  maxBlocks: AI_IMPORT_HARD_LIMITS.blocks,
  blockCharacters: 12_000,
  blockBytes: 45_000,
  maxBlocksPerRequest: 5,
  maxQuestionsPerBlock: 50,
  maxQuestionsPerJob: 2000,
} as const;
export type AiDocumentBlockStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface AiDocumentFailure {
  code: string;
  message: string;
  stage: 'plan' | 'generate';
  retryable: boolean;
  auditId?: string;
}
export interface AiDocumentSectionInput {
  text: string;
  label?: string;
  sourceName?: string;
  pageStart?: number;
  pageEnd?: number;
  sourceCitation?: DocumentCitation;
}
export interface AiDocumentJobInput {
  confirmed: true;
  sourceName: string;
  sourceUrl?: string;
  sections: AiDocumentSectionInput[];
  saveSources?: boolean;
  mode?: AiImportMode;
  requirements?: string;
  questionTypes?: QuestionType[];
  difficulty?: number;
  categoryIds?: string[];
  tagIds?: string[];
  questionsPerBlock?: number;
  maxQuestions?: number;
}
export interface AiDocumentBlock {
  id: string;
  sourceName: string;
  label: string;
  pageStart?: number;
  pageEnd?: number;
  characters: number;
  title: string;
  summary: string;
  topics: string[];
  planStatus: AiDocumentBlockStatus;
  generationStatus: AiDocumentBlockStatus;
  planAttempts: number;
  generationAttempts: number;
  planFailure?: AiDocumentFailure;
  generationFailure?: AiDocumentFailure;
  questions: QuestionInput[];
  importedQuestionIds: string[];
  planRunId?: string;
  generationRunId?: string;
  generationQuestionLimit?: number;
  sourceCitation?: DocumentCitation;
}
export interface AiDocumentJobSummary {
  id: string;
  sourceName: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
  status: 'pending' | 'running' | 'ready' | 'partial' | 'failed' | 'completed';
  blockCount: number;
  plannedBlocks: number;
  failedBlocks: number;
  generatedBlocks: number;
  questionCount: number;
  importedCount: number;
}
export interface AiDocumentJob extends AiDocumentJobSummary {
  mode: AiImportMode;
  requirements: string;
  questionTypes: QuestionType[];
  difficulty?: number;
  categoryIds: string[];
  tagIds: string[];
  questionsPerBlock: number;
  maxQuestions: number;
  blocks: AiDocumentBlock[];
}
export interface AiDocumentProcessInput {
  blockIds: string[];
  retryFailed?: boolean;
  questionsPerBlock?: number;
}
export interface AiDocumentImportInput {
  confirmed: true;
  blockIds: string[];
  questions?: Array<{ blockId: string; questions: QuestionInput[] }>;
}
export interface AiDocumentImportResult {
  added: number;
  reused?: number;
  updated?: number;
  items: QuestionInput[];
  job: AiDocumentJob;
}
