import {migrateFeedbackQualityIssues} from '../content-quality/feedback-links.js';
import {retireMissingSourceIssues,retireMissingExplanationIssues} from '../content-quality/maintenance.js';
import {qualityScanSchema,qualityIssueSchema} from '../content-quality/schema.js';
import {normalizeQuestionBlankStems} from '../../../shared/questions/blank-markers.js';
import { z } from 'zod';
import type { Category, Question } from '../../../shared/models/types.js';
import { Store, makeId, now, tables, type Table } from '../../core/store.js';
import { categorySchema, domainSchema, tagSchema, questionSchema, snapshotQuestionSchema, questionBankSchema, documentSchema, filtersSchema, answersSchema, storedScoringSchema, id, parse, fail, moneySchema } from '../../core/validation.js';
import { QUICK_PAPER_ID, validateAttemptSnapshot, type StoredAttempt, type StoredPaper } from '../practice/service.js';
import { normalizeScoring } from '../practice/scoring.js';
import { validatePaperAnswers } from '../questions/structure.js';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings.js';
import { settingsSchema, getSettings } from '../settings/routes.js';
import { assetRecordSchema, validateAssetRecord } from '../assets/schema.js';
import { validateAllAssetReferences } from '../assets/routes.js';
import { paperDraftSchema, validatePaperDraft } from '../practice/paper-drafts.js';
import type { PaperDraftState } from '../../../shared/practice/paper-drafts.js';
import { cleanLearningEnvelope } from '../../../shared/questions/learning-records.js';
import { cleanLegacyBankFilters, legacyBankPaper, legacyBankPaperId, migrateLegacyBanks } from '../banks/legacy-banks.js';
import { studyPartKey } from '../../../shared/questions/study-state.js';
import { learningResultSchema, validateLearningResult, migrateLearningResults } from '../practice/learning-results.js';
import { validateConceptPaperSnapshot } from '../practice/concept-practice.js';
import { validateVocabularyPaperSnapshot } from '../practice/vocabulary-practice.js';
import { questionHistorySchema,validateQuestionHistory,migrateQuestionHistory } from '../questions/history-store.js';
import { dailyPushRecordSchema, validateDailyPushConfiguration } from '../daily-push/schema.js';
import { documentDraftSchema, validateDocumentDraftState } from '../library/document-draft-schema.js';
import { ratingSchema, reviewCardSchema, reviewEventSchema } from '../review-scheduler/schema.js';
import { mirrorReviewStudy, validateReviewImport } from '../review-scheduler/service.js';
import { questionFeedbackSchema } from '../quality-feedback/schema.js';
import { practiceTimingStateSchema } from '../practice/practice-timing.js';

const datetime = z.string().datetime({ offset: true });
const snapshotQuestion = snapshotQuestionSchema.refine(q => Boolean(q.id), '快照题目必须有题号');
const paperSchema = z.object({
  id, title: z.string().min(1).max(300), description: z.string().max(500000).default(''), mode: z.enum(['manual', 'random']), practiceKind: z.enum(['standard','vocabulary','concept']).optional(), legacyBankId: id.optional(), questionIds: z.array(id).max(50000).refine(a => new Set(a).size === a.length, '题集题号不能重复'), filters: filtersSchema.nullable().default(null),
  archived: z.boolean().default(false), version: z.number().int().min(1).default(1), createdAt: datetime.optional(), updatedAt: datetime.optional(), snapshot: z.array(snapshotQuestion).max(50000).optional(), scoring: storedScoringSchema.optional(),
  organization: z.enum(['domain', 'other']).default('other'), domainId: id.nullable().default(null),
});
const attemptSchema = z.object({
  id, paperId: id, paperTitle: z.string().max(300), paperVersion: z.number().int().min(1), source: z.enum(['paper','quick']).default('paper'), updatedAt: datetime.optional(), referenceViewedAt: datetime.nullable().optional(), status: z.enum(['in_progress', 'submitted']), questions: z.array(snapshotQuestion).min(1).max(500), answers: answersSchema,
  objectiveScore: moneySchema, objectiveMax: moneySchema, subjectiveScore: moneySchema, subjectiveMax: moneySchema, startedAt: datetime, submittedAt: datetime.nullable(), scoring: storedScoringSchema.optional(),
  practiceKind: z.enum(['standard','vocabulary','concept']).optional(), vocabularyDirection: z.enum(['word_to_meaning','meaning_to_word']).optional(),
  practiceMode: z.enum(['practice','exam']).optional(), durationMinutes: z.number().int().min(1).max(1440).nullable().optional(), deadlineAt: datetime.nullable().optional(), elapsedSeconds: z.number().int().nonnegative().optional(), autoSubmitted: z.boolean().optional(), practiceTiming: practiceTimingStateSchema.optional(),
});
const studySchema = z.object({ questionId: id, favorite: z.boolean(), mastery: z.number().int().min(0).max(3).nullable(), notes: z.string().max(500000), nextReviewAt: datetime.nullable(), lastReviewedAt: datetime.nullable(), wrongCount: z.number().int().nonnegative() });
const partStudySchema = studySchema.extend({ partId: id, favorite: z.literal(false).default(false) });
const reviewSchema = z.object({ id: id.optional(), questionId: id, partId: id.optional(), mastery: z.number().int().min(0).max(3), reviewedAt: datetime, source: z.string().max(100).default('manual'), attemptId: id.optional(), rating: ratingSchema.optional(), schedulerEventId: z.string().min(1).max(1600).optional() });
const envelopeSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().optional(), exportedAt: z.string().optional(),
  domains: z.array(domainSchema.extend({ id })), categories: z.array(categorySchema.extend({ id })), tags: z.array(tagSchema.extend({ id })), questions: z.array(questionSchema), documents: z.array(documentSchema.extend({ _archived: z.boolean().optional() })), papers: z.array(paperSchema),
  study: z.array(studySchema).default([]), studyParts: z.array(partStudySchema).default([]), learningResults: z.array(learningResultSchema).default([]), reviews: z.array(reviewSchema).default([]), attempts: z.array(attemptSchema).default([]),
  questionBanks: z.array(questionBankSchema.safeExtend({ id })).default([]),
  settings: z.array(settingsSchema).max(1).default([]), assets: z.array(assetRecordSchema).default([]),
  paperDrafts: z.array(paperDraftSchema).default([]),
  documentDrafts: z.array(documentDraftSchema).default([]),
  questionHistory:z.array(questionHistorySchema).default([]),
  dailyPushes:z.array(dailyPushRecordSchema).default([]),
  reviewCards: z.array(reviewCardSchema).default([]), reviewEvents: z.array(reviewEventSchema).default([]),
  questionFeedback: z.array(questionFeedbackSchema).default([]),
  qualityScans: z.array(qualityScanSchema).default([]), qualityIssues: z.array(qualityIssueSchema).default([]),
});
const dataKey = (table: Table) => table === 'question_banks' ? 'questionBanks' : table === 'paper_drafts' ? 'paperDrafts' : table === 'document_drafts' ? 'documentDrafts' : table === 'study_parts' ? 'studyParts' : table === 'learning_results' ? 'learningResults' : table==='question_history'?'questionHistory':table==='daily_pushes'?'dailyPushes':table==='review_cards'?'reviewCards':table==='review_events'?'reviewEvents':table==='question_feedback'?'questionFeedback':table==='quality_scans'?'qualityScans':table==='quality_issues'?'qualityIssues':table;
const recordKey = (table: Table, record: any) => table === 'study' ? record.questionId : table === 'study_parts' ? studyPartKey(record.questionId, record.partId) : record.id;

export function exportData(store: Store) {
  const papers = store.all<StoredPaper>('papers');
  for (const bank of store.all<any>('question_banks')) {
    const target = legacyBankPaperId(store, bank.id);
    if (!target.existing) papers.push(legacyBankPaper(bank, bank.questionIds.map((qid: string) => store.require<Question>('questions', qid)), target.id));
  }
  return { schemaVersion: 1, exportedAt: now(), ...Object.fromEntries(tables.map(table => [dataKey(table), table === 'question_banks' ? [] : table === 'papers' ? papers : store.all(table)])) };
}
export function importData(store: Store, raw: unknown) {
  const data = parse(envelopeSchema, cleanLegacyBankFilters(cleanLearningEnvelope(raw)));
  for (const table of tables) {
    const records = data[dataKey(table)];
    const keys = records.map((r: any) => recordKey(table, r)).filter(Boolean);
    if (new Set(keys).size !== keys.length) fail(400, 'DUPLICATE_IMPORT_ID', `导入数据包含重复 ID：${table}`);
    if (table !== 'reviews' && keys.length !== records.length) fail(400, 'IMPORT_ID_REQUIRED', `导入数据缺少 ID：${table}`);
  }
  const result: Record<string, { added: number; skipped: number }> = {};
  return store.transaction(() => {
    function insert(table: Table, records: any[], key: string | ((record: any) => string) = 'id') {
      const counts = result[dataKey(table)] = { added: 0, skipped: 0 };
      for (const value of records) {
        const entityId = (typeof key === 'function' ? key(value) : value[key]) || makeId(table.slice(0, -1));
        if (store.get(table, entityId)) { counts.skipped++; continue; }
        store.insert(table, entityId, table === 'reviews' ? { ...value, id: entityId } : value); counts.added++;
      }
    }
    for (const asset of data.assets) validateAssetRecord(asset);
    insert('assets', data.assets);
    // An untouched installation may restore its original preferences. A merge
    // into an already configured installation retains the local preferences.
    const current = getSettings(store), { updatedAt: _defaultTime, ...defaultValues } = DEFAULT_SETTINGS, { updatedAt: _currentTime, ...currentValues } = current;
    if (data.settings.length && JSON.stringify(currentValues) === JSON.stringify(defaultValues)) {
      store.put('settings', 'system', data.settings[0]); result.settings = { added: 1, skipped: 0 };
    } else insert('settings', data.settings);
    insert('domains', data.domains); insert('tags', data.tags);
    // Parent records may appear in any order. Validate all inserted categories
    // only after the full set exists; any failure rolls back every table.
    insert('categories', data.categories);
    for (const c of store.all<Category>('categories')) store.validateCategory(c);
    insert('questions', data.questions.map(raw => { const q=normalizeQuestionBlankStems(raw); return ({ ...q, createdAt: q.createdAt || now(), updatedAt: q.updatedAt || now() }); }));
    insert('documents', data.documents.map(d => ({ ...d, updatedAt: d.updatedAt || now() })));
    store.normalizeLegacyTags(); store.validateTaxonomyReferences();
    validateDailyPushConfiguration(store, getSettings(store).dailyPush);
    const papers: StoredPaper[] = [];
    for (const p of data.papers) {
      if (p.id === QUICK_PAPER_ID) fail(400, 'RESERVED_PAPER_ID', '随机单题标识不能用作题集ID');
      if (p.organization === 'domain' && !p.domainId) fail(400, 'PAPER_DOMAIN_REQUIRED', '领域专项题集缺少领域');
      if (p.organization === 'other' && p.domainId) fail(400, 'PAPER_DOMAIN_MISMATCH', '其他题集不能指定所属领域');
      if (p.domainId) store.require('domains', p.domainId);
      if (store.get('papers', p.id)) { papers.push(p as unknown as StoredPaper); continue; }
      if (p.filters) {
        if (p.filters.domainId) store.require('domains', p.filters.domainId);
        if (p.filters.categoryId) store.require('categories', p.filters.categoryId);
        // Cross-set selection is only an authoring convenience; the snapshot
        // remains authoritative if its source set is later removed.
        if (p.filters.paperId && !store.get('papers', p.filters.paperId) && !data.papers.some(source => source.id === p.filters!.paperId)) fail(400, 'INVALID_REFERENCE', '题集筛选来源不存在');
        for (const t of p.filters.tagIds || []) store.require('tags', t);
      }
      const snapshot = p.snapshot || p.questionIds.map(qid => store.require<Question>('questions', qid));
      if (snapshot.length !== p.questionIds.length || snapshot.some((q, i) => q.id !== p.questionIds[i])) fail(400, 'INVALID_SNAPSHOT', '题集快照必须与题号及顺序一致');
      validatePaperAnswers(snapshot as Question[], 1_500_000);
      if (p.practiceKind === 'vocabulary') validateVocabularyPaperSnapshot(snapshot as Question[], true);
      if (p.practiceKind === 'concept') validateConceptPaperSnapshot(snapshot as Question[]);
      for (const qid of p.questionIds) store.require('questions', qid);
      const scoring = normalizeScoring(snapshot as Question[], p.scoring as any);
      papers.push({ ...p, snapshot: snapshot as Question[], scoring, questionCount: snapshot.length, createdAt: p.createdAt || now(), updatedAt: p.updatedAt || now() });
    }
    insert('papers', papers);
    insert('daily_pushes', data.dailyPushes);
    for (const bank of data.questionBanks) {
      for (const qid of bank.questionIds) store.require('questions', qid);
      if (!store.get('question_banks', bank.id)) store.insert('question_banks', bank.id, bank);
    }
    const paperCountBefore = store.all('papers').length;
    migrateLegacyBanks(store);
    result.papers!.added += store.all('papers').length - paperCountBefore;
    for (const draft of data.paperDrafts) validatePaperDraft(store, draft.state as PaperDraftState, { allowUnpublished: true });
    insert('paper_drafts', data.paperDrafts);
    for (const draft of data.documentDrafts) if (!store.get('document_drafts', draft.id)) validateDocumentDraftState(store, draft.state, true);
    insert('document_drafts', data.documentDrafts);
    for (const state of data.study) store.require('questions', state.questionId);
    insert('study', data.study, 'questionId');
    // Keep removed-part history in a backup without assigning it to another
    // current part. Readers validate current membership before using it.
    for (const state of data.studyParts) store.require('questions', state.questionId);
    insert('study_parts', data.studyParts, value => studyPartKey(value.questionId, value.partId));
    for (const a of data.attempts) {
      if (a.source === 'quick') {
        if (a.paperId !== QUICK_PAPER_ID || a.paperVersion !== 1) fail(400, 'INVALID_ATTEMPT_SOURCE', '随机单题来源与固定标识不一致');
        const roots = new Set(a.questions.map(q => q.sourceQuestionId || q.id));
        if (roots.size !== 1) fail(400, 'INVALID_ATTEMPT_SOURCE', '随机单题会话只能包含一道来源题及其子题');
      } else {
        if (a.paperId === QUICK_PAPER_ID || a.referenceViewedAt) fail(400, 'INVALID_ATTEMPT_SOURCE', '题集会话不能使用随机单题标识或提前查看解析');
        const paper = store.get<StoredPaper>('papers', a.paperId);
        if (paper && a.paperVersion > paper.version) fail(400, 'INVALID_ATTEMPT', '作答版本高于题集版本');
      }
      const questionIds = a.questions.map(q => q.id!);
      if (new Set(questionIds).size !== questionIds.length || Object.keys(a.answers).some(qid => !questionIds.includes(qid))) fail(400, 'INVALID_ATTEMPT', '作答题号不属于快照或重复');
      if ((a.status === 'in_progress') !== (a.submittedAt === null)) fail(400, 'INVALID_ATTEMPT', '作答状态与交卷时间不一致');
      // Historical attempts own complete snapshots. A source question may have
      // been deleted after a later paper version stopped referencing it.
      validateAttemptSnapshot(a as StoredAttempt);
      a.scoring = normalizeScoring(a.questions as Question[], a.scoring as any);
      if (a.source === 'quick' && a.scoring.enabled) fail(400, 'INVALID_ATTEMPT_SOURCE', '随机单题会话不使用题集计分');
      a.updatedAt = a.updatedAt || a.submittedAt || a.startedAt;
    }
    insert('attempts', data.attempts);
    const importedAttempts = new Map(data.attempts.map(value => [value.id, value as StoredAttempt]));
    insert('learning_results', data.learningResults.map(value => validateLearningResult(store, value, importedAttempts.get(value.id))));
    migrateLearningResults(store);
    // The envelope already checked every row's schema. A colliding index keeps
    // its local version, which may reflect a newer grade than this backup.
    insert('question_history',data.questionHistory.map(value=>store.get('question_history',value.id)?value:validateQuestionHistory(store,value)));
    migrateQuestionHistory(store,true,!(raw&&typeof raw==='object'&&Object.hasOwn(raw,'questionHistory')));
    // Reviews remain useful study events after retention removes their attempt.
    for (const r of data.reviews) store.require('questions', r.questionId);
    insert('reviews', data.reviews);
    insert('question_feedback', data.questionFeedback);
    insert('quality_scans', data.qualityScans); insert('quality_issues', data.qualityIssues);
    retireMissingSourceIssues(store);retireMissingExplanationIssues(store);migrateFeedbackQualityIssues(store);
    // A memory card and its complete event chain are one import unit. Keeping
    // the local aggregate avoids mixing incompatible grades or replay baselines.
    const adaptive = validateReviewImport(data.reviewCards, data.reviewEvents);
    const localCards = new Set(adaptive.cards.filter(card => store.get('review_cards', card.id)).map(card => card.id));
    const newEvents = adaptive.events.filter(event => !localCards.has(event.cardId));
    for (const event of newEvents) if (store.get('review_events', event.id)) fail(409, 'REVIEW_EVENT_COLLISION', '导入复习事件与本机其他记忆卡冲突，请使用完整SQLite恢复或保留本机版本');
    insert('review_cards', adaptive.cards);
    insert('review_events', newEvents);
    result.reviewEvents!.skipped += adaptive.events.length - newEvents.length;
    if (getSettings(store).reviewScheduling.strategy === 'fsrs') for (const card of adaptive.cards) if (!localCards.has(card.id) && store.get('questions', card.questionId)) mirrorReviewStudy(store, card);
    validateAllAssetReferences(store);
    return { mode: 'merge', counts: result };
  });
}
