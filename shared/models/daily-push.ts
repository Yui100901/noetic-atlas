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
export interface DailyPushRecord {
  id: string; dateKey: string; generatedAt: string; paperId: string | null; title: string;
  domainId: string; categoryIds: string[];
  targetReviewPoints: number; baseNewPoints: number; targetNewPoints: number; targetTotalPoints: number; transferredPoints: number;
  reviewPoints: number; newPoints: number; totalPoints: number;
  reviewCount: number; newCount: number; questionIds: string[]; reviewQuestionIds: string[]; newQuestionIds: string[];
  pointsByType: Record<QuestionType, number>;
  shortfall: number; reason: string; readAt: string | null;
}
export interface DailyPushView extends DailyPushRecord { paperAvailable: boolean }
export interface DailyPushOverview { config: DailyPushSettings; today: DailyPushView | null; unreadCount: number; recent: DailyPushView[]; recentLimit: number; nextDateKey: string }
export interface DailyPushCheckResult { generated: boolean; record: DailyPushRecord | null }
export interface DailyPushCheckResponse extends DailyPushCheckResult { overview: DailyPushOverview }
