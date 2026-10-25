import type { DailyPushCheckResult, DailyPushOverview, DailyPushRecord, DailyPushView } from '../../../shared/models/daily-push.js';
import type { QuestionType } from '../../../shared/models/types.js';
import { makeId, type Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { getSettings } from '../settings/service.js';
import { buildPaper } from '../practice/service.js';
import { dailyCalendar, isDailyPushDue, nextDateKey } from './calendar.js';
import { dailyPushRecordSchema, validateDailyPushConfiguration } from './schema.js';
import { selectDailyQuestions } from './selection.js';

export function dailyPushOverview(store: Store, at = new Date()): DailyPushOverview {
  const config = getSettings(store).dailyPush, dateKey = dailyCalendar(at, config.timeZone).dateKey;
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  const today = store.get<DailyPushRecord>('daily_pushes', `daily-${dateKey}`);
  const records = db.all(db.query.selectFrom('daily_pushes').select('data').orderBy(field('data', 'dateKey'), 'desc').limit(30)).map(row => JSON.parse(row.data) as DailyPushRecord);
  const paperIds = [...new Set([...records, ...(today ? [today] : [])].flatMap(record => record.paperId ? [record.paperId] : []))];
  const available = new Set(paperIds.length ? db.all(db.query.selectFrom('papers').select('id').where(db.expressions.idInJson('id', paperIds)).where(eb => eb.or([eb(field('data', 'archived'), 'is', null), eb(field('data', 'archived'), '=', 0)]))).map(row => row.id) : []);
  const view = (record: DailyPushRecord): DailyPushView => ({ ...record, paperAvailable: !!record.paperId && available.has(record.paperId) });
  const recent = records.map(view);
  const unreadCount = Number(db.one(db.query.selectFrom('daily_pushes').select(eb => eb.fn.countAll<number>().as('total')).where(field('data', 'readAt'), 'is', null))?.total || 0);
  return { config, today: today ? view(today) : null, recent, recentLimit: 30, unreadCount, nextDateKey: nextDateKey(config, at, !!today) };
}

/** The first write claims the unique date before reading selection state. SQLite
 * and other transactional drivers serialize competing processes on this row. */
export function checkDailyPush(store: Store, at = new Date()): DailyPushCheckResult {
  const initial = getSettings(store), { dateKey } = dailyCalendar(at, initial.dailyPush.timeZone), id = `daily-${dateKey}`;
  if (!isDailyPushDue(initial.dailyPush, at)) return { generated: false, record: store.get<DailyPushRecord>('daily_pushes', id) || null };
  validateDailyPushConfiguration(store, initial.dailyPush);
  const current = store.get<DailyPushRecord>('daily_pushes', id); if (current) return { generated: false, record: current };
  return store.transaction(() => {
    const config = initial.dailyPush;
    const claim: DailyPushRecord = { id, dateKey, generatedAt: at.toISOString(), paperId: null, title: `${dateKey} 每日推荐`, domainId: config.domainId!, categoryIds: [...config.categoryIds], targetReviewPoints: config.reviewPoints, baseNewPoints: config.newPoints, targetNewPoints: config.newPoints, targetTotalPoints: Math.round((config.reviewPoints + config.newPoints) * 100) / 100, transferredPoints: 0, reviewPoints: 0, newPoints: 0, totalPoints: 0, reviewCount: 0, newCount: 0, questionIds: [], reviewQuestionIds: [], newQuestionIds: [], pointsByType: { ...initial.pointsByType }, shortfall: Math.round((config.reviewPoints + config.newPoints) * 100) / 100, reason: '生成中', readAt: null };
    const db = store.database;
    const inserted = db.run(db.query.insertInto('daily_pushes').values({ id, data: JSON.stringify(claim) }).onConflict(conflict => conflict.column('id').doNothing()));
    if (!Number(inserted.changes)) return { generated: false, record: store.require<DailyPushRecord>('daily_pushes', id) };
    // Re-read after taking the write lock. Configuration changes do not alter an
    // already generated day, and disabling never creates a new notification.
    const settings = getSettings(store), active = settings.dailyPush;
    if (!isDailyPushDue(active, at) || dailyCalendar(at, active.timeZone).dateKey !== dateKey) { store.remove('daily_pushes', id); return { generated: false, record: null }; }
    validateDailyPushConfiguration(store, active);
    const selected = selectDailyQuestions(store, active, settings.pointsByType, at);
    const { answerSlots: _slots, available: _available, ...selection } = selected;
    const title = claim.title;
    let paperId: string | null = null;
    if (selected.questionIds.length) {
      const metadata = new Map(store.questionMetadataByIds(selected.questionIds).items.map(question => [question.id, question.type]));
      const questionPoints = Object.fromEntries(selected.questionIds.map(id => [id, settings.pointsByType[metadata.get(id) as QuestionType]]));
      const paper = buildPaper(store, { id: makeId('daily-paper'), title, description: `每日推题：复习${selected.reviewPoints}分，新题${selected.newPoints}分；按生成时的系统默认题型分值计分。${selected.reason}`, mode: 'manual', organization: 'domain', domainId: active.domainId, questionIds: selected.questionIds, scoring: { enabled: true, totalPoints: selected.totalPoints, questionPoints, pointsByType: { ...settings.pointsByType } } });
      store.insert('papers', paper.id, paper); paperId = paper.id;
    }
    const record = parse(dailyPushRecordSchema, { ...claim, ...selection, title, paperId, domainId: active.domainId, categoryIds: [...active.categoryIds], targetReviewPoints: active.reviewPoints, baseNewPoints: active.newPoints, targetTotalPoints: Math.round((active.reviewPoints + active.newPoints) * 100) / 100, reviewCount: selected.reviewQuestionIds.length, newCount: selected.newQuestionIds.length, pointsByType: { ...settings.pointsByType } }) as DailyPushRecord;
    store.put('daily_pushes', id, record);
    return { generated: true, record };
  });
}

export function readDailyPush(store: Store, id: string, at = new Date()): DailyPushRecord {
  return store.transaction(() => { const record = store.require<DailyPushRecord>('daily_pushes', id); if (record.readAt) return record; const saved = { ...record, readAt: at.toISOString() }; store.put('daily_pushes', id, saved); return saved; });
}
