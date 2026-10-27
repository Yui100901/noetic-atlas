import type { ContextLearningQuestion, ContextLearningSummary } from './context-learning.js';
import type { VocabularyDirection, PaperPracticeKind } from '../models/types.js';

export type GlobalLearningKind = 'wrong' | 'favorite' | 'due';
export interface GlobalLearningCounts { wrong: number; favorite: number; due: number }
export interface GlobalLearningSummary { counts: GlobalLearningCounts }
/** Complete provenance, never silently truncated. A paper membership without an
 * attempt is retained separately from that paper's latest retained attempt. */
export interface LearningOrigin {
  practiceKind?: PaperPracticeKind; vocabularyDirection?: VocabularyDirection;
  source: 'paper' | 'quick' | 'library';
  paperId?: string;
  /** Saved title for an attempt, current title for a membership. */
  paperTitle: string;
  deleted?: boolean;
  archived?: boolean;
  attemptId?: string;
  /** The compact source/error snapshot survives pruning the whole attempt. */
  historyAvailable?: boolean;
  paperVersion?: number;
  startedAt?: string;
  submittedAt?: string | null;
  questionId?: string;
  answerState?: 'incorrect' | 'unanswered';
  /** Retained mistakes for this leaf within this origin's practice context. */
  wrongCount?: number;
}
export interface GlobalLearningQuestion extends ContextLearningQuestion {
  /** JSON tuple [owning original question ID, leaf ID], safe for arbitrary IDs. */
  key: string;
  /** Wrong: latest judged-wrong attempt per still-wrong context. Favorite/due:
   * every current paper membership and latest retained attempt per context;
   * library is used only when there are no memberships or attempts. */
  origins: LearningOrigin[];
  /** Wrong uses the most recent erroneous attempt's immutable snapshot;
   * favorites/review use the surviving original question's current content. */
  snapshotSource: 'attempt' | 'library';
}
export interface LearningCardSummary {
  paperId: string;
  counts: ContextLearningSummary['counts'];
}
export interface LearningCardSummaries { items: LearningCardSummary[] }
