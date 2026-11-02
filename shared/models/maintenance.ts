export const CLEANUP_KINDS = [
  'unused_assets',
  'practice_drafts',
  'paper_drafts',
  'document_drafts',
  'ai_drafts',
  'attempt_history',
  'question_history',
  'focus_history',
  'ai_history',
] as const;
export type CleanupKind = (typeof CLEANUP_KINDS)[number];
export const CLEANUP_LABELS: Record<CleanupKind, string> = {
  unused_assets: '未引用的文件',
  practice_drafts: '旧作答草稿',
  paper_drafts: '旧组题草稿',
  document_drafts: '旧资料草稿',
  ai_drafts: '旧AI工作台草稿',
  attempt_history: '旧整卷历史',
  question_history: '旧单题详细回答',
  focus_history: '旧专注复习总结',
  ai_history: '独立AI处理历史',
};
export interface CleanupSelection {
  kinds: CleanupKind[];
  olderThanDays: number;
}
export interface CleanupPreview {
  fingerprint: string;
  selection: CleanupSelection;
  cutoff: string;
  total: number;
  logicalBytes: number;
  items: Array<{
    kind: CleanupKind;
    count: number;
    bytes: number;
    samples: Array<{ id: string; title: string; date: string }>;
  }>;
  protectedAiRuns: number;
}
export interface LearningResetSelection {
  scope: 'all' | 'paper' | 'quick';
  paperId?: string;
  mode: 'progress' | 'complete';
}
export interface MaintenanceOperation {
  at: string;
  kind: 'cleanup' | 'reset' | 'compact' | 'reindex';
  summary: string;
  count: number;
}
export interface DataHealth {
  checkedAt: string;
  storage: { databaseBytes: number; freeBytes: number; pageSize: number; integrity?: string[] };
  counts: Record<string, number>;
  unusedAssets: number;
  unusedAssetBytes: number;
  activeAiJobs: number;
  issues: Array<{ level: 'warning' | 'info'; message: string; href?: string }>;
  operations: MaintenanceOperation[];
}
export interface ScopedResetPreview {
  fingerprint: string;
  selection: LearningResetSelection;
  title: string;
  counts: {
    states: number;
    partStates: number;
    reviews: number;
    results: number;
    reviewCards: number;
    reviewEvents: number;
    questionHistory: number;
    focusSessions: number;
    planProgress: number;
  };
  retained: { attempts: number; drafts: number; sharedState: boolean; mixedFocus: number };
  removed: {
    attempts: number;
    drafts: number;
    questionHistory: number;
    study: number;
    aiGrades: number;
  };
}
