import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { fail, id, leafId, parse, snapshotQuestionSchema } from '../../core/validation.js';
import type { StoredAttempt } from './service.js';
import type { StoredLeafQuestion } from '../questions/structure.js';
import { normalizeScoring } from './scoring.js';
import { learningJudgment, learningQuestionKey, type LearningJudgingItem } from './learning-state.js';
import { isAnswerPresent } from '../../../shared/practice/attempt-timing.js';
import { preserveQuestionHistory } from '../questions/history-store.js';

const stamp = z.string().datetime({ offset: true });
const itemSchema = z.object({
  id: leafId, sourceQuestionId: id.optional(), partId: id.optional(),
  judgment: z.enum(['correct', 'partial', 'incorrect', 'unanswered']).optional(), answered: z.boolean().optional(),
}).strict();
/** Independent learning evidence deliberately excludes answers, correct-question
 * bodies and whole-paper scores. Wrong leaves retain their own reading material. */
export const learningResultSchema = z.object({
  id, source: z.enum(['paper', 'quick']), paperId: id, paperTitle: z.string().max(300),
  paperVersion: z.number().int().positive(), status: z.literal('submitted'),
  startedAt: stamp, submittedAt: stamp, updatedAt: stamp,
  reset: z.literal(true).optional(), items: z.array(itemSchema).max(500),
  historyIndexed:z.literal(true).optional(),
  questions: z.array(snapshotQuestionSchema.safeExtend({ id: leafId })).max(500),
}).strict().superRefine((value, ctx) => {
  if (value.reset && (value.items.length || value.questions.length)) ctx.addIssue({ code: 'custom', message: '重置标记不能携带旧学习结果' });
  for (const item of value.items) {
    if (item.partId ? !item.sourceQuestionId || item.id !== `${item.sourceQuestionId}::${item.partId}` : item.id.length > 160 || item.sourceQuestionId !== undefined) ctx.addIssue({ code: 'custom', message: '学习结果的原题与小题身份不一致' });
  }
  const keys = value.items.map(item => learningQuestionKey(item.sourceQuestionId || item.id, item.id));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: '学习结果题号不能重复' });
  const wrong = new Set(value.items.filter(item => item.judgment && item.judgment !== 'correct').map(item => learningQuestionKey(item.sourceQuestionId || item.id, item.id)));
  const snapshotKeys = value.questions.map(q => learningQuestionKey(q.sourceQuestionId || q.id!, q.id!));
  if (snapshotKeys.length !== wrong.size || new Set(snapshotKeys).size !== snapshotKeys.length || snapshotKeys.some(key => !wrong.has(key))) ctx.addIssue({ code: 'custom', message: '错题结果必须具有对应且唯一的题目快照' });
  for (const question of value.questions) {
    const q = question as StoredLeafQuestion;
    const item = value.items.find(item => learningQuestionKey(item.sourceQuestionId || item.id, item.id) === learningQuestionKey(q.sourceQuestionId || q.id, q.id));
    if (!q.id || q.type === 'group' || q.partId !== item?.partId) ctx.addIssue({ code: 'custom', message: '学习结果必须使用一致的小题快照' });
    if (q.partId && (q.sourceQuestionId !== q.groupId || q.id !== `${q.groupId}::${q.partId}` || q.groupTitle === undefined || q.groupStemMarkdown === undefined || q.partIndex === undefined)) ctx.addIssue({ code: 'custom', message: '错题小题的来源与公共材料不完整' });
  }
  if ((value.source === 'quick') !== (value.paperId === 'quick-practice') || (value.source === 'quick' && value.paperVersion !== 1)) ctx.addIssue({ code: 'custom', message: '学习结果的来源标识不一致' });
});
export type LearningResult = Omit<z.infer<typeof learningResultSchema>, 'questions'> & { questions: StoredLeafQuestion[] };
export type LearningResultItem = z.infer<typeof itemSchema>;

const orderedJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export function validateLearningResult(store: Store, input: unknown, importedAttempt?: StoredAttempt): LearningResult {
  let result = parse(learningResultSchema, input);
  if (importedAttempt) {
    if (importedAttempt.status !== 'submitted') fail(400, 'LEARNING_RESULT_MISMATCH', '未提交作答不能携带已判学习结果');
    const expected = parse(learningResultSchema, resultFromAttempt(importedAttempt));
    if(!result.reset)result={...result,items:result.items.map(item=>{const prior=expected.items.find(value=>value.id===item.id&&value.sourceQuestionId===item.sourceQuestionId);return item.answered===undefined?{...item,answered:prior?.answered,...(item.judgment==='incorrect'&&prior?.judgment==='partial'?{judgment:'partial' as const}:{})}:item;})};
    const origin = (value: LearningResult) => [value.id, value.source, value.paperId, value.paperTitle, value.paperVersion, value.startedAt, value.submittedAt];
    // This maintenance marker is absent from genuine old backups. Preserve that
    // absence until the history migration can recover their retained answers.
    const evidence = ({ historyIndexed: _indexed, ...value }: LearningResult) => value;
    if (orderedJson(origin(result)) !== orderedJson(origin(expected)) || !result.reset && orderedJson(evidence(result)) !== orderedJson(evidence(expected))) fail(400, 'LEARNING_RESULT_MISMATCH', '学习结果与同一备份中的原作答不一致');
  }
  // Asset references are checked by the enclosing import's complete graph
  // validation, after every table is present. Keep retention free of HTTP/config
  // module dependencies so schema imports have no initialization cycle.
  return result;
}

export function resultFromAttempt(attempt: StoredAttempt): LearningResult {
  const scoring = normalizeScoring(attempt.questions, attempt.scoring);
  const questions: StoredLeafQuestion[] = [];
  const items = attempt.questions.map(q => {
    const answer = attempt.answers[q.id];
    const judgment = learningJudgment({ ...q, answerValue: answer?.value, selfScore: answer?.selfScore, verdict:answer?.verdict, scoringEnabled: scoring.enabled, maximumPoints: scoring.questionPoints[q.id] });
    if (judgment?.wrong) { const { study: _state, partStudies: _parts, ...snapshot } = q; questions.push(snapshot); }
    return { id: q.id, answered:isAnswerPresent(answer), ...(q.sourceQuestionId ? { sourceQuestionId: q.sourceQuestionId } : {}), ...(q.partId ? { partId: q.partId } : {}), ...(judgment ? { judgment: judgment.wrong ? judgment.verdict||judgment.answerState! : 'correct' as const } : {}) };
  });
  return { id: attempt.id, historyIndexed:true, source: attempt.source || 'paper', paperId: attempt.paperId, paperTitle: attempt.paperTitle, paperVersion: attempt.paperVersion, status: 'submitted', startedAt: attempt.startedAt, submittedAt: attempt.submittedAt!, updatedAt: attempt.updatedAt || attempt.submittedAt || attempt.startedAt, items, questions };
}

/** Call inside the same transaction as submit/grade and BEFORE history pruning. */
export function preserveLearningResults(store: Store, attempt: StoredAttempt): void {
  if (attempt.status !== 'submitted') return;
  const previous=store.get<LearningResult>('learning_results',attempt.id);
  if(!previous?.reset)store.put('learning_results', attempt.id, resultFromAttempt(attempt));
  preserveQuestionHistory(store,attempt,true,!previous?.historyIndexed);
}

/** Idempotent upgrade/import: previously pruned history cannot be reconstructed. */
export function migrateLearningResults(store: Store): number {
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  const missing = db.all(db.query.selectFrom('attempts as a').leftJoin('learning_results as r', 'r.id', 'a.id').select('a.data').where('r.id', 'is', null).where(field('a.data', 'status'), '=', 'submitted'));
  for (const row of missing) preserveLearningResults(store, JSON.parse(row.data) as StoredAttempt);
  return missing.length;
}

export interface LearningMetadata {
  id: string; source: 'paper' | 'quick' | null; paperId: string; paperTitle: string; paperVersion: number;
  status: 'in_progress' | 'submitted'; startedAt: string; submittedAt: string | null; updatedAt: string | null;
  items: Array<LearningResultItem>; historyAvailable: boolean;
}

/** Summaries read compact evidence, not saved answer text or wrong snapshots.
 * A read-only fallback supports a caller's newly inserted legacy attempts. */
export function learningMetadata(store: Store, options: { paperIds?: readonly string[]; source?: 'paper' | 'quick'; paperId?: string } = {}): LearningMetadata[] {
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  const filter = <T>(query: T): T => {
    let value: any = query;
    if (options.paperIds) value = value.where((eb: any) => eb.or([eb(field('a.data', 'source'), '=', 'paper'), eb(field('a.data', 'source'), 'is', null)])).where(field('a.data', 'paperId'), 'in', options.paperIds);
    if (options.source) value = value.where((eb: any) => options.source === 'quick' ? eb(field('a.data', 'source'), '=', 'quick') : eb.or([eb(field('a.data', 'source'), '=', 'paper'), eb(field('a.data', 'source'), 'is', null)]));
    if (options.paperId) value = value.where(field('a.data', 'paperId'), '=', options.paperId);
    return value;
  };
  const columns = [field<'paper' | 'quick' | null>('a.data', 'source').as('source'), field<string>('a.data', 'paperId').as('paperId'), field<string>('a.data', 'paperTitle').as('paperTitle'), field<number>('a.data', 'paperVersion').as('paperVersion'), field<'in_progress' | 'submitted'>('a.data', 'status').as('status'), field<string>('a.data', 'startedAt').as('startedAt'), field<string | null>('a.data', 'submittedAt').as('submittedAt'), field<string | null>('a.data', 'updatedAt').as('updatedAt')];
  const saved = db.all(filter(db.query.selectFrom('learning_results as a').leftJoin('attempts as retained', 'retained.id', 'a.id').select('a.id').select(columns).select([field<string>('a.data', 'items').as('items'), 'retained.id as retainedId'])));
  const fallback = db.all(filter(db.query.selectFrom('attempts as a').leftJoin('learning_results as saved', 'saved.id', 'a.id').select('a.id').select(columns).select(db.expressions.attemptLearningItems('a.data').as('items')).where('saved.id', 'is', null)));
  return [
    ...saved.map(row => ({ ...row, historyAvailable: !!row.retainedId, items: JSON.parse(row.items) as LearningResultItem[] })),
    ...fallback.map(row => ({ ...row, historyAvailable: true, items: (JSON.parse(row.items) as LearningJudgingItem[]).map(item => { const judgment = row.status === 'submitted' ? learningJudgment(item) : undefined; return { id: item.id, ...(item.sourceQuestionId ? { sourceQuestionId: item.sourceQuestionId } : {}), ...((item as any).partId ? { partId: (item as any).partId } : {}), ...(judgment ? { judgment: judgment.wrong ? judgment.answerState! : 'correct' as const } : {}) }; }) })),
  ].sort((a, b) => Date.parse(b.submittedAt || b.updatedAt || b.startedAt) - Date.parse(a.submittedAt || a.updatedAt || a.startedAt) || b.id.localeCompare(a.id));
}

/** Fetch only the selected wrong content. References survive original deletion. */
export function learningSnapshots(store: Store, selections: Array<{ attemptId: string; sourceId: string; id: string }>): Map<string, Map<string, StoredLeafQuestion>> {
  const db = store.database;
  const attemptIds = [...new Set(selections.map(item => item.attemptId))];
  if (!attemptIds.length) return new Map();
  const retained = db.all(db.query.selectFrom('attempts').select('id').select(db.expressions.selectedLearningQuestions('data', selections).as('data')).where(db.expressions.idInJson('id', attemptIds)));
  const snapshots = new Map(retained.map(row => [row.id, new Map((JSON.parse(row.data) as StoredLeafQuestion[]).map(q => [learningQuestionKey(q.sourceQuestionId || q.id, q.id), q]))] as const));
  const missing = attemptIds.filter(id => !snapshots.has(id));
  if (missing.length) for (const row of db.all(db.query.selectFrom('learning_results').select('id').select(db.expressions.selectedLearningQuestions('data', selections).as('data')).where(db.expressions.idInJson('id', missing)))) {
    snapshots.set(row.id, new Map((JSON.parse(row.data) as StoredLeafQuestion[]).map(q => [learningQuestionKey(q.sourceQuestionId || q.id, q.id), q])));
  }
  return snapshots;
}
