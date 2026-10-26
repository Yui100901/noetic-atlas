import type { ReviewSchedulingSettings } from './settings.js';

export const REVIEW_RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export type ReviewRating = typeof REVIEW_RATINGS[number];
export const REVIEW_DIRECTIONS = ['standard', 'word_to_meaning', 'meaning_to_word'] as const;
export type ReviewDirection = typeof REVIEW_DIRECTIONS[number];
export const REVIEW_RATING_LABELS: Record<ReviewRating, string> = { again: '重学', hard: '困难', good: '良好', easy: '轻松' };
export interface ReviewIdentity { questionId: string; partId?: string; direction: ReviewDirection }
export interface FsrsMemory {
  due: string; stability: number; difficulty: number; elapsed_days: number; scheduled_days: number;
  learning_steps: number; reps: number; lapses: number; state: 0 | 1 | 2 | 3; last_review?: string;
}
export interface ReviewCard extends ReviewIdentity {
  id: string; algorithm: 'FSRS-6'; libraryVersion: '5.4.2';
  memory: FsrsMemory; baseline: FsrsMemory; dueAt: string | null; lastReviewedAt: string | null;
  legacyDueAt: string | null; legacyLastReviewedAt: string | null;
  suspended: boolean; manualDueAt: string | null; createdAt: string; updatedAt: string;
}
export interface ReviewEvent extends ReviewIdentity {
  id: string; cardId: string; source: 'attempt' | 'manual'; attemptId?: string; leafId?: string;
  rating: ReviewRating; ratingSource: 'automatic' | 'manual'; occurredAt: string; recordedAt: string; updatedAt: string;
  parameters: ReviewSchedulingSettings; algorithm: 'FSRS-6'; libraryVersion: '5.4.2';
  before: FsrsMemory; after: FsrsMemory;
}
export interface ReviewPreview { rating: ReviewRating; label: string; dueAt: string; intervalSeconds: number; scheduledDays: number }
export interface ReviewCardView extends ReviewIdentity {
  strategy: 'fsrs' | 'fixed'; card: ReviewCard | null; dueAt: string | null; lastReviewedAt: string | null;
  suspended: boolean; state: 'new' | 'learning' | 'review' | 'relearning'; retrievability: number | null;
  preview: ReviewPreview[]; eventCount: number; latestRating: ReviewRating | null;
  canReview: boolean; reason?: string;
}
export interface AttemptReviewItem extends ReviewIdentity {
  leafId: string; eligible: boolean; reason?: string; eventId?: string; rating?: ReviewRating;
  ratingSource?: 'automatic' | 'manual'; card: ReviewCard | null;
}
export interface AttemptReviewOverview { attemptId: string; strategy: 'fsrs' | 'fixed'; items: AttemptReviewItem[] }
export interface ReviewQueueSummary { due: number; overdue: number; relearning: number; today: number; suspended: number }
export interface ReviewQueueItem extends ReviewIdentity {
  key: string; title: string; partTitle?: string; href: string; card: ReviewCard | null;
  dueAt: string; reason: 'legacy' | 'overdue' | 'relearning' | 'today';
}
export interface ReviewQueue { items: ReviewQueueItem[]; total: number; page: number; pageSize: number; summary: ReviewQueueSummary }
