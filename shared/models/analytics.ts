/** Actual submitted work. Repeated answers and distinct knowledge items differ. */
export interface AnalyticsMetrics {
  sessions: number; answeredSessions: number; paperSessions: number; quickSessions: number;
  answers: number; uniqueItems: number; uniqueQuestions: number;
  correct: number; partial: number; incorrect: number; ungraded: number; omitted: number; unknown: number;
  graded: number; accuracy: number | null;
  elapsedSeconds: number; timedSessions: number; missingTimeSessions: number;
  reviewEvents: number; activeDays: number;
}
export interface AnalyticsBreakdown {
  id: string; label: string; answers: number; uniqueItems: number;
  correct: number; partial: number; incorrect: number; ungraded: number; graded: number; accuracy: number | null;
}
/** Recall feedback describes memory, independently of strict answer accuracy. */
export interface AdaptiveRecallMetrics {
  feedbackEvents: number; recallSuccesses: number; recallSuccessRate: number | null;
}
export interface AdaptiveAnalytics extends AdaptiveRecallMetrics {
  uniqueCards: number;
  ratings: { again: number; hard: number; good: number; easy: number };
  timing: Record<'new' | 'early' | 'due' | 'overdue' | 'unknown', AdaptiveRecallMetrics>;
  /** Present only at the live cutoff. Historical queue snapshots are not retained. */
  queue: { asOf: string; due: number; overdue: number; relearning: number; today: number; suspended: number } | null;
  dueProcessing: { completedDueCycles: number; pendingDue: number | null; rate: number | null; reason: string };
}
export interface AnalyticsReport {
  range: { from: string; to: string; timeZone: string; asOf: string; partial: boolean };
  summary: AnalyticsMetrics;
  adaptive?: AdaptiveAnalytics;
  daily: Array<{ date: string; metrics: AnalyticsMetrics }>;
  domains: AnalyticsBreakdown[]; types: AnalyticsBreakdown[];
  recommendations: Array<{ id: string; title: string; description: string; href: string }>;
  quality: {
    unknownAnswerItems: number; missingTypeAnswers: number; missingDomainAnswers: number;
    missingDurationSessions: number; resetExcludedSessions: number; warnings: string[];
  };
}
export interface WeeklyReport {
  weekStart: string; weekEnd: string; timeZone: string; generatedAt: string; isCurrentWeek: boolean;
  current: AnalyticsReport;
  comparison: {
    mode: 'matched_elapsed' | 'full_week'; from: string; to: string; label: string; summary: AnalyticsMetrics;
    adaptive?: AdaptiveAnalytics;
    deltas: { answers: number; sessions: number; elapsedSeconds: number; activeDays: number; accuracyPoints: number | null };
  };
}
