import { createEmptyCard, fsrs, Rating, StrategyMode, type Card, type Grade } from 'ts-fsrs';
import type { FsrsMemory, ReviewRating } from '../../../shared/models/adaptive-review.js';
import type { ReviewSchedulingSettings } from '../../../shared/models/settings.js';

const ratings: Record<ReviewRating, Grade> = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
export const serializeMemory = (card: Card): FsrsMemory => { const { last_review, ...memory } = card; return { ...memory, state: card.state as FsrsMemory['state'], due: card.due.toISOString(), ...(last_review ? { last_review: last_review.toISOString() } : {}) }; };
export const emptyMemory = (at: Date): FsrsMemory => serializeMemory(createEmptyCard(at));
export function reviewMemory(card: FsrsMemory, rating: ReviewRating, at: Date, parameters: ReviewSchedulingSettings, seed: string): FsrsMemory {
  const scheduler = fsrs({ request_retention: parameters.desiredRetention, maximum_interval: parameters.maximumIntervalDays,
    learning_steps: parameters.learningStepsMinutes.map(value => `${value}m` as const), relearning_steps: parameters.relearningStepsMinutes.map(value => `${value}m` as const), enable_fuzz: parameters.enableFuzz, enable_short_term: true });
  scheduler.useStrategy(StrategyMode.SEED, () => seed);
  return serializeMemory(scheduler.next(card, at, ratings[rating]).card);
}
export function retrievability(card: FsrsMemory, at: Date): number | null {
  if (!card.last_review || !card.reps) return null;
  return Math.max(0, Math.min(1, fsrs().get_retrievability(card, at, false)));
}
