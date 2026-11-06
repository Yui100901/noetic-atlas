import type { Question, QuestionInput, QuestionStatus, QuestionType } from './types.js';

export type ImportDedupAction = 'replace' | 'keep' | 'both';
export interface ImportDedupDecision {
  key: string;
  action: ImportDedupAction;
  targetId?: string;
}
export interface ImportDedupCandidate {
  id: string;
  title: string;
  type: QuestionType;
  status: QuestionStatus;
  score: number;
  reason: string;
  incomingIndex?: number;
}
export interface ImportDedupItem {
  key: string;
  index: number;
  title: string;
  type: QuestionType;
  kind: 'new' | 'exact' | 'similar';
  targetId?: string;
  duplicateOf?: string;
  candidates: ImportDedupCandidate[];
}
export interface ImportDedupPreview {
  fingerprint: string;
  total: number;
  counts: { new: number; exact: number; similar: number };
  items: ImportDedupItem[];
  metrics: { indexed: number; compared: number; candidateLimit: number };
}
export interface ImportDedupDetail {
  incoming: QuestionInput;
  existing: Question | QuestionInput;
}
export interface ImportDedupOptions {
  expectedFingerprint?: string;
  decisions?: ImportDedupDecision[];
}
