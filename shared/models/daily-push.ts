import type { QuestionType } from './types.js';

export interface DailyPushSettings {
  enabled: boolean;
  domainId: string | null;
  categoryIds: string[];
  reviewPoints: number;
  newPoints: number;
  scheduleTime: string;
  timeZone: string;
}
export const DEFAULT_DAILY_PUSH: DailyPushSettings = { enabled: false, domainId: null, categoryIds: [], reviewPoints: 30, newPoints: 20, scheduleTime: '00:00', timeZone: 'Asia/Shanghai' };
/** Frozen identities and maxima, without question text or answers. */
export interface DailyPushAnswerItem {
  id: string; sourceQuestionId: string; partId?: string;
  type: Exclude<QuestionType, 'group'>; points: number;
}
export interface DailyPushProgress {
  status: 'not_started' | 'in_progress' | 'submitted' | 'completed' | 'unavailable';
  totalQuestions: number; answeredQuestions: number; answeredPoints: number; totalPoints: number; percent: number;
  omittedQuestions: number; pendingGradingCount: number;
  resumeAttemptId: string | null; resultAttemptId: string | null; submittedAt: string | null;
  historyAvailable: boolean; detailsAvailable: boolean;
}
export interface DailyPushRecord {
  id: string; dateKey: string; generatedAt: string; paperId: string | null; title: string;
  domainId: string; categoryIds: string[];
  targetReviewPoints: number; baseNewPoints: number; targetNewPoints: number; targetTotalPoints: number; transferredPoints: number;
  reviewPoints: number; newPoints: number; totalPoints: number;
  reviewCount: number; newCount: number; questionIds: string[]; reviewQuestionIds: string[]; newQuestionIds: string[];
  pointsByType: Record<QuestionType, number>;
  shortfall: number; reason: string; readAt: string | null;
  answerItems?: DailyPushAnswerItem[];
}
export interface DailyPushView extends DailyPushRecord { paperAvailable: boolean; progress: DailyPushProgress }
export interface DailyPushOverview { config: DailyPushSettings; today: DailyPushView | null; unreadCount: number; recent: DailyPushView[]; recentLimit: number; nextDateKey: string }
export interface DailyPushCheckResult { generated: boolean; record: DailyPushRecord | null }
export interface DailyPushCheckResponse extends DailyPushCheckResult { overview: DailyPushOverview }
