import { z } from 'zod';
import { DEFAULT_SETTINGS, THEMES, type RetentionPreview, type SystemSettings } from '../../../shared/models/settings.js';
import { nextStamp, type Store } from '../../core/store.js';
import { fail, typePointsSchema } from '../../core/validation.js';
import type { StoredAttempt } from '../practice/service.js';
import { paperDraftRetentionCandidates } from '../practice/paper-draft-retention.js';
import { preserveLearningResults } from '../practice/learning-results.js';
import { archiveAttemptQuestionHistory, questionHistoryRetentionCandidates } from '../questions/history-store.js';

export const settingsSchema = z.object({
  id: z.literal('system'), updatedAt: z.string().datetime({ offset: true }),
  theme: z.enum(THEMES).default('green'),
  maxDraftsPerPaper: z.number().int().min(1).max(100), maxQuickDrafts: z.number().int().min(1).max(100),
  maxPaperDrafts: z.number().int().min(1).max(100).default(3), examDurationMinutes: z.number().int().min(1).max(1440).default(120),
  maxHistoryPerPaper: z.number().int().min(0).max(10000), maxQuickHistory: z.number().int().min(0).max(10000),
  maxQuestionHistory:z.number().int().min(0).max(10000).default(10),
  randomQuestionCount: z.number().int().min(1).max(500), scoringEnabledByDefault: z.boolean(),
  randomTotalPoints: z.number().finite().positive().max(10000).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, '总分最多两位小数'),
  objectivePercent: z.number().finite().min(0).max(100),
  pointsByType: typePointsSchema.required(),
  reviewIntervalsDays: z.tuple([z.number().int().min(0).max(3650), z.number().int().min(0).max(3650), z.number().int().min(0).max(3650), z.number().int().min(0).max(3650)]),
  autosaveDebounceMs: z.number().int().min(100).max(10000),
  maxDocumentMiB: z.number().int().min(1).max(50), maxImageMiB: z.number().int().min(1).max(20),
}).strict();

export function getSettings(store: Store): SystemSettings {
  const value = store.get<SystemSettings>('settings', 'system');
  return structuredClone({ ...DEFAULT_SETTINGS, ...value });
}

export function ensureSettings(store: Store) {
  if (!store.get('settings', 'system')) store.put('settings', 'system', { ...structuredClone(DEFAULT_SETTINGS), updatedAt: nextStamp() });
}

export function retentionCandidates(store: Store, settings: SystemSettings, only?: { source: 'paper' | 'quick'; paperId: string; status: 'in_progress' | 'submitted'; preserveId?: string }) {
  if (only) {
    const draft = only.status === 'in_progress', quick = only.source === 'quick';
    const limit = draft ? quick ? settings.maxQuickDrafts : settings.maxDraftsPerPaper : quick ? settings.maxQuickHistory : settings.maxHistoryPerPaper;
    if (!draft && limit === 0) return [];
    const db = store.database, field = db.expressions.field.bind(db.expressions);
    let query = db.query.selectFrom('attempts').select('id').select([
      field<string>('data', 'startedAt').as('startedAt'), field<string | null>('data', 'updatedAt').as('updatedAt'),
      field<string | null>('data', 'submittedAt').as('submittedAt'), field<string | null>('data', 'practiceMode').as('practiceMode'),
    ]).where(field('data', 'paperId'), '=', only.paperId).where(field('data', 'status'), '=', only.status);
    query = only.source === 'quick' ? query.where(field('data', 'source'), '=', 'quick') : query.where(eb => eb.or([eb(field('data', 'source'), '=', 'paper'), eb(field('data', 'source'), 'is', null)]));
    const entries = db.all(query).filter(entry => !(draft && entry.practiceMode === 'exam'));
    entries.sort((a, b) => (draft ? b.updatedAt || b.startedAt : b.submittedAt || b.startedAt).localeCompare(draft ? a.updatedAt || a.startedAt : a.submittedAt || a.startedAt) || b.id.localeCompare(a.id));
    const preserve = only.preserveId && entries.find(entry => entry.id === only.preserveId);
    const ordered = preserve ? [preserve, ...entries.filter(entry => entry.id !== preserve.id)] : entries;
    // Only attempts selected for deletion need their frozen content and answers.
    return ordered.slice(limit).map(entry => store.require<StoredAttempt>('attempts', entry.id));
  }
  const groups = new Map<string, StoredAttempt[]>();
  for (const attempt of store.all<StoredAttempt>('attempts')) {
    if (attempt.practiceMode === 'exam' && attempt.status === 'in_progress') continue;
    const source = attempt.source || 'paper';
    const key = JSON.stringify([source, attempt.paperId, attempt.status]);
    const group = groups.get(key) || []; group.push(attempt); groups.set(key, group);
  }
  const removed: StoredAttempt[] = [];
  for (const entries of groups.values()) {
    const first = entries[0]!, quick = first.source === 'quick', draft = first.status === 'in_progress';
    const limit = draft ? quick ? settings.maxQuickDrafts : settings.maxDraftsPerPaper : quick ? settings.maxQuickHistory : settings.maxHistoryPerPaper;
    if (!draft && limit === 0) continue;
    // Draft recency follows last save, history follows submission time. Reading
    // or grading a historical attempt never extends its retention lifetime.
    entries.sort((a, b) => {
      const timeA = draft ? a.updatedAt || a.startedAt : a.submittedAt || a.startedAt;
      const timeB = draft ? b.updatedAt || b.startedAt : b.submittedAt || b.startedAt;
      return timeB.localeCompare(timeA) || b.id.localeCompare(a.id);
    });
    removed.push(...entries.slice(limit));
  }
  return removed;
}

export function retentionPreview(attempts: StoredAttempt[]): RetentionPreview {
  const drafts = attempts.filter(a => a.status === 'in_progress').length;
  return { drafts, history: attempts.length - drafts, total: attempts.length };
}

export function applyAttemptRetention(store: Store, attempt: StoredAttempt) {
  for (const old of retentionCandidates(store, getSettings(store), { source: attempt.source || 'paper', paperId: attempt.paperId, status: attempt.status, preserveId: attempt.id })) { preserveLearningResults(store, old); archiveAttemptQuestionHistory(store,old); store.remove('attempts', old.id); }
}

export function settingsRetentionPlan(store: Store, settings: SystemSettings) {
  const attempts = retentionCandidates(store, settings);
  const authoring = paperDraftRetentionCandidates(store, settings.maxPaperDrafts);
  const retention = retentionPreview(attempts);
  const questionHistory=questionHistoryRetentionCandidates(store,settings.maxQuestionHistory);
  if(questionHistory.length){retention.questionHistory=questionHistory.length;retention.total+=questionHistory.length;}
  if (authoring.length) { retention.authoring = authoring.length; retention.total += authoring.length; }
  return { attempts, authoring, questionHistory, retention };
}

/** Caller owns the transaction, so configuration import can atomically update both sections. */
export function saveSettings(store: Store, settings: SystemSettings, options: { confirmedRetention?: boolean; expectedRetention?: RetentionPreview } = {}) {
  const previous = getSettings(store);
  if (settings.updatedAt !== previous.updatedAt) fail(409, 'SETTINGS_VERSION_CONFLICT', '配置已被修改，请刷新后重新编辑');
  const { attempts, authoring, questionHistory, retention } = settingsRetentionPlan(store, settings);
  if (retention.total && !options.confirmedRetention) fail(409, 'RETENTION_CONFIRMATION_REQUIRED', '保存此配置会清理超过保留上限的草稿或已提交历史，请确认后再次保存', retention);
  if (options.confirmedRetention && options.expectedRetention && (['drafts', 'history', 'total', 'authoring', 'questionHistory'] as const).some(key => (options.expectedRetention![key] || 0) !== (retention[key] || 0))) fail(409, 'RETENTION_CONFIRMATION_REQUIRED', '确认期间待清理记录数量已变化，请重新检查当前数量', retention);
  const saved = { ...settings, updatedAt: nextStamp(previous.updatedAt) };
  store.put('settings', 'system', saved);
  for(const old of questionHistory)store.remove('question_history',old);
  for (const old of attempts) { preserveLearningResults(store, old); archiveAttemptQuestionHistory(store,old); store.remove('attempts', old.id); }
  for (const old of authoring) store.remove('paper_drafts', old.id);
  return { settings: saved, retention };
}
