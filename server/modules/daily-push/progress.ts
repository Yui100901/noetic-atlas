import type { DailyPushAnswerItem, DailyPushProgress, DailyPushRecord } from '../../../shared/models/daily-push.js';
import type { QuestionType } from '../../../shared/models/types.js';
import type { Store } from '../../core/store.js';
import { isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { learningQuestionKey } from '../practice/learning-state.js';
import { expandPaper, type StoredPaper } from '../practice/service.js';
import { cents, fromCents } from '../practice/scoring.js';

interface ProgressItem {
  id: string; sourceQuestionId?: string; partId?: string | null; type?: QuestionType;
  points?: number | null; answered?: boolean | number; selfScore?: number | null; verdict?: string | null; judgment?: string;
}
interface Evidence {
  id: string; paperId: string; status: 'in_progress' | 'submitted'; startedAt: string; updatedAt: string | null; submittedAt: string | null;
  items: ProgressItem[]; retained: boolean; reset?: boolean;
}
const key = (item: Pick<ProgressItem, 'id' | 'sourceQuestionId'>) => learningQuestionKey(item.sourceQuestionId || item.id, item.id);
const stamp = (entry: Evidence) => Date.parse(entry.submittedAt || entry.updatedAt || entry.startedAt) || 0;
const order = (left: Evidence, right: Evidence) => stamp(right) - stamp(left) || right.id.localeCompare(left.id);
const sameRootSet = (items: DailyPushAnswerItem[], record: DailyPushRecord) => {
  const roots = new Set(items.map(item => item.sourceQuestionId));
  return items.length <= 500 && roots.size === record.questionIds.length && record.questionIds.every(id => roots.has(id))
    && new Set(items.map(key)).size === items.length && items.every(item => Number.isFinite(item.points) && item.points >= 0)
    && items.reduce((sum, item) => sum + cents(item.points), 0) === cents(record.totalPoints);
};
function empty(record: DailyPushRecord, status: DailyPushProgress['status'] = 'not_started'): DailyPushProgress {
  return { status, totalQuestions: 0, answeredQuestions: 0, answeredPoints: 0, totalPoints: record.totalPoints, percent: 0, omittedQuestions: 0, pendingGradingCount: 0, resumeAttemptId: null, resultAttemptId: null, submittedAt: null, historyAvailable: false, detailsAvailable: status !== 'unavailable' };
}

/** Progress is a read-only view of one practice session, not a sum of retries.
 * Original recommendation identities/maxima remain frozen when papers change.
 * Retained attempts override compact evidence (including learning-reset markers)
 * because resetting learning does not erase an existing practice sheet. */
export function dailyPushProgress(store: Store, input: readonly DailyPushRecord[]): Map<string, DailyPushProgress> {
  const records = [...new Map(input.map(record => [record.id, record])).values()];
  const result = new Map(records.map(record => [record.id, empty(record, !record.paperId ? 'unavailable' : 'not_started')]));
  const paperIds = [...new Set(records.flatMap(record => record.paperId ? [record.paperId] : []))];
  if (!paperIds.length) return result;
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  const papers = db.all(db.query.selectFrom('papers').select('id').select(field<number>('data', 'version').as('version')).where(db.expressions.idInJson('id', paperIds)));
  const versions = new Map(papers.map(paper => [paper.id, paper.version]));
  const headers = [field<string>('a.data', 'paperId').as('paperId'), field<'in_progress' | 'submitted'>('a.data', 'status').as('status'), field<string>('a.data', 'startedAt').as('startedAt'), field<string | null>('a.data', 'submittedAt').as('submittedAt'), field<string | null>('a.data', 'updatedAt').as('updatedAt')];
  // Query only original-version sessions belonging to these recommendations.
  // JSON expressions return presence flags, never answers.
  const attempts = db.all(db.query.selectFrom('attempts as a').select('a.id').select(headers).select(db.expressions.attemptProgressItems('a.data').as('items'))
    .where(field('a.data', 'paperId'), 'in', paperIds).where(field('a.data', 'paperVersion'), '=', 1)
    .where(eb => eb.or([eb(field('a.data', 'source'), '=', 'paper'), eb(field('a.data', 'source'), 'is', null)])));
  const saved = db.all(db.query.selectFrom('learning_results as a').select('a.id').select(headers).select([field<string>('a.data', 'items').as('items'), field<boolean | null>('a.data', 'reset').as('reset')])
    .where(field('a.data', 'paperId'), 'in', paperIds).where(field('a.data', 'paperVersion'), '=', 1).where(field('a.data', 'source'), '=', 'paper'));
  const evidence = new Map<string, Evidence>();
  for (const row of saved) evidence.set(row.id, { ...row, items: JSON.parse(row.items), retained: false, reset: !!row.reset });
  for (const row of attempts) evidence.set(row.id, { ...row, items: JSON.parse(row.items), retained: true });
  const byPaper = new Map<string, Evidence[]>();
  for (const entry of evidence.values()) { const entries = byPaper.get(entry.paperId) || []; entries.push(entry); byPaper.set(entry.paperId, entries); }

  // Old backups predate answerItems. Recover their original metadata through a
  // pure projection of v1 source rows; a dirty read model must never be rebuilt
  // by this GET. Neither full question bodies nor a whole paper are decoded.
  const legacyIds = records.filter(record => record.paperId && !record.answerItems && versions.get(record.paperId) === 1).map(record => record.paperId!);
  const legacyPapers = legacyIds.length ? db.all(db.query.selectFrom('papers').select('id').select([db.expressions.paperProgressRoots('data').as('roots'), field<any>('data', 'scoring').as('scoring')]).where(db.expressions.idInJson('id', legacyIds))) : [];
  const legacy = new Map<string, DailyPushAnswerItem[]>();
  for (const paper of legacyPapers) {
    try {
      const snapshot = JSON.parse(paper.roots), scoring = typeof paper.scoring === 'string' ? JSON.parse(paper.scoring) : paper.scoring;
      const expanded = expandPaper({ snapshot, scoring } as StoredPaper, 500);
      legacy.set(paper.id, expanded.questions.map(question => ({ id: question.id, sourceQuestionId: question.sourceQuestionId || question.id, ...(question.partId ? { partId: question.partId } : {}), type: question.type as Exclude<QuestionType, 'group'>, points: expanded.scoring.questionPoints[question.id]! })));
    } catch { /* A modified/invalid source must not invent original progress. */ }
  }

  for (const record of records) {
    if (!record.paperId) continue;
    const entries = byPaper.get(record.paperId) || [];
    let basis = record.answerItems || legacy.get(record.paperId);
    if (!basis) {
      // A complete retained v1 session is also an independent frozen basis.
      for (const entry of [...entries].filter(entry => entry.retained).sort(order)) {
        const items = entry.items.map(item => ({ id: item.id, sourceQuestionId: item.sourceQuestionId || item.id, ...(item.partId ? { partId: item.partId } : {}), type: item.type as DailyPushAnswerItem['type'], points: item.points! }));
        if (sameRootSet(items, record)) { basis = items; break; }
      }
    }
    if (!basis || !sameRootSet(basis, record)) { result.set(record.id, empty(record, 'unavailable')); continue; }
    const original = new Map(basis.map(item => [key(item), item]));
    const measure = (entry: Evidence) => {
      let answeredQuestions = 0, pointCents = 0, pending = 0, known = !entry.reset && !!entry.items.length;
      const seen = new Set<string>();
      for (const item of entry.items) {
        const identity = key(item), question = original.get(identity);
        if (!question || seen.has(identity) || item.type && item.type !== question.type) continue;
        seen.add(identity);
        const answered = item.answered === true || item.answered === 1 || item.answered === undefined && !!item.judgment && item.judgment !== 'unanswered';
        if (item.answered === undefined && !item.judgment) known = false;
        if (!answered) continue;
        answeredQuestions++; pointCents += cents(question.points);
        if (entry.status === 'submitted' && isSubjectiveType(question.type) && (entry.retained ? item.selfScore == null && !item.verdict : !item.judgment)) pending++;
      }
      return { entry, answeredQuestions, pointCents, pending, known };
    };
    const submitted = entries.filter(entry => entry.status === 'submitted').map(measure).sort((a, b) => b.pointCents - a.pointCents || b.answeredQuestions - a.answeredQuestions || order(a.entry, b.entry));
    const draft = entries.filter(entry => entry.status === 'in_progress' && entry.retained).sort(order)[0];
    const selected = submitted[0] || (draft ? measure(draft) : undefined), value = empty(record);
    value.totalQuestions = basis.length;
    value.resumeAttemptId = draft?.id || null;
    if (selected) {
      value.answeredQuestions = selected.answeredQuestions; value.answeredPoints = fromCents(selected.pointCents);
      value.percent = record.totalPoints ? Math.min(100, Math.round(selected.pointCents / cents(record.totalPoints) * 10000) / 100) : 0;
      value.detailsAvailable = selected.known;
      value.historyAvailable = selected.entry.status === 'submitted' && selected.entry.retained;
      value.resultAttemptId = value.historyAvailable ? selected.entry.id : null;
      value.submittedAt = selected.entry.status === 'submitted' ? selected.entry.submittedAt : null;
      value.omittedQuestions = selected.entry.status === 'submitted' && selected.known ? basis.length - selected.answeredQuestions : 0;
      value.pendingGradingCount = selected.pending;
      value.status = selected.entry.status === 'in_progress' ? 'in_progress' : selected.known && selected.answeredQuestions === basis.length ? 'completed' : 'submitted';
    } else if ((versions.get(record.paperId) || 1) !== 1) { value.status = 'unavailable'; value.detailsAvailable = false; }
    result.set(record.id, value);
  }
  return result;
}
