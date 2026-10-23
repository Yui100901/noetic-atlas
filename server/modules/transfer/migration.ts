import { z } from 'zod';
import type { Category, Question, QuestionBank, StudyState } from '../../../shared/models/types.js';
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

const datetime = z.string().datetime({ offset: true });
const snapshotQuestion = snapshotQuestionSchema.refine(q => Boolean(q.id), '快照题目必须有题号');
const paperSchema = z.object({
  id, title: z.string().min(1).max(300), description: z.string().max(500000).default(''), mode: z.enum(['manual', 'random']), questionIds: z.array(id).min(1).max(500).refine(a => new Set(a).size === a.length, '试卷题号不能重复'), filters: filtersSchema.nullable().default(null),
  archived: z.boolean().default(false), version: z.number().int().min(1).default(1), createdAt: datetime.optional(), updatedAt: datetime.optional(), snapshot: z.array(snapshotQuestion).optional(), scoring: storedScoringSchema.optional(),
  organization: z.enum(['domain', 'other']).default('other'), domainId: id.nullable().default(null),
});
const attemptSchema = z.object({
  id, paperId: id, paperTitle: z.string().max(300), paperVersion: z.number().int().min(1), source: z.enum(['paper','quick']).default('paper'), updatedAt: datetime.optional(), referenceViewedAt: datetime.nullable().optional(), status: z.enum(['in_progress', 'submitted']), questions: z.array(snapshotQuestion).min(1).max(500), answers: answersSchema,
  objectiveScore: moneySchema, objectiveMax: moneySchema, subjectiveScore: moneySchema, subjectiveMax: moneySchema, startedAt: datetime, submittedAt: datetime.nullable(), scoring: storedScoringSchema.optional(),
  practiceMode: z.enum(['practice','exam']).optional(), durationMinutes: z.number().int().min(1).max(1440).nullable().optional(), deadlineAt: datetime.nullable().optional(), elapsedSeconds: z.number().int().nonnegative().optional(), autoSubmitted: z.boolean().optional(),
});
const studySchema = z.object({ questionId: id, favorite: z.boolean(), mastery: z.number().int().min(0).max(3).nullable(), notes: z.string().max(500000), nextReviewAt: datetime.nullable(), lastReviewedAt: datetime.nullable(), wrongCount: z.number().int().nonnegative() });
const reviewSchema = z.object({ id: id.optional(), questionId: id, mastery: z.number().int().min(0).max(3), reviewedAt: datetime, source: z.string().max(100).default('manual'), attemptId: id.optional() });
const envelopeSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().optional(), exportedAt: z.string().optional(),
  domains: z.array(domainSchema.extend({ id })), categories: z.array(categorySchema.extend({ id })), tags: z.array(tagSchema.extend({ id })), questions: z.array(questionSchema), documents: z.array(documentSchema.extend({ _archived: z.boolean().optional() })), papers: z.array(paperSchema),
  study: z.array(studySchema).default([]), reviews: z.array(reviewSchema).default([]), attempts: z.array(attemptSchema).default([]),
  questionBanks: z.array(questionBankSchema.safeExtend({ id })).default([]),
  settings: z.array(settingsSchema).max(1).default([]), assets: z.array(assetRecordSchema).default([]),
  paperDrafts: z.array(paperDraftSchema).default([]),
});
const dataKey = (table: Table) => table === 'question_banks' ? 'questionBanks' : table === 'paper_drafts' ? 'paperDrafts' : table;

export function exportData(store: Store) {
  return { schemaVersion: 1, exportedAt: now(), ...Object.fromEntries(tables.map(table => [dataKey(table), store.all(table)])) };
}
export function importData(store: Store, raw: unknown) {
  const data = parse(envelopeSchema, cleanLearningEnvelope(raw));
  for (const table of tables) {
    const records = data[dataKey(table)];
    const keys = records.map((r: any) => table === 'study' ? r.questionId : r.id).filter(Boolean);
    if (new Set(keys).size !== keys.length) fail(400, 'DUPLICATE_IMPORT_ID', `导入数据包含重复 ID：${table}`);
    if (table !== 'reviews' && keys.length !== records.length) fail(400, 'IMPORT_ID_REQUIRED', `导入数据缺少 ID：${table}`);
  }
  const result: Record<string, { added: number; skipped: number }> = {};
  return store.transaction(() => {
    function insert(table: Table, records: any[], key = 'id') {
      const counts = result[dataKey(table)] = { added: 0, skipped: 0 };
      for (const value of records) {
        const entityId = value[key] || makeId(table.slice(0, -1));
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
    insert('questions', data.questions.map(q => ({ ...q, createdAt: q.createdAt || now(), updatedAt: q.updatedAt || now() })));
    insert('documents', data.documents.map(d => ({ ...d, updatedAt: d.updatedAt || now() })));
    store.normalizeLegacyTags(); store.validateTaxonomyReferences();
    // Banks are references, independent from categories and collection flags.
    // Insert after source questions, then validate the merged graph atomically.
    insert('question_banks', data.questionBanks.map(bank => ({ ...bank, createdAt: bank.createdAt || now(), updatedAt: bank.updatedAt || now() })));
    for (const bank of [...data.questionBanks, ...store.all<QuestionBank>('question_banks')]) for (const qid of bank.questionIds) store.require('questions', qid);
    const papers: StoredPaper[] = [];
    for (const p of data.papers) {
      if (p.id === QUICK_PAPER_ID) fail(400, 'RESERVED_PAPER_ID', '随机单题标识不能用作试卷ID');
      if (p.organization === 'domain' && !p.domainId) fail(400, 'PAPER_DOMAIN_REQUIRED', '领域专项练习卷缺少领域');
      if (p.organization === 'other' && p.domainId) fail(400, 'PAPER_DOMAIN_MISMATCH', '其他练习卷不能指定所属领域');
      if (p.domainId) store.require('domains', p.domainId);
      if (store.get('papers', p.id)) { papers.push(p as unknown as StoredPaper); continue; }
      if (p.filters) {
        if (p.filters.domainId) store.require('domains', p.filters.domainId);
        if (p.filters.categoryId) store.require('categories', p.filters.categoryId);
        if (p.filters.bankId) store.require('question_banks', p.filters.bankId);
        for (const t of p.filters.tagIds || []) store.require('tags', t);
      }
      const snapshot = p.snapshot || p.questionIds.map(qid => store.require<Question>('questions', qid));
      if (snapshot.length !== p.questionIds.length || snapshot.some((q, i) => q.id !== p.questionIds[i])) fail(400, 'INVALID_SNAPSHOT', '试卷快照必须与题号及顺序一致');
      validatePaperAnswers(snapshot as Question[]);
      for (const qid of p.questionIds) store.require('questions', qid);
      const scoring = normalizeScoring(snapshot as Question[], p.scoring as any);
      papers.push({ ...p, snapshot: snapshot as Question[], scoring, questionCount: snapshot.length, createdAt: p.createdAt || now(), updatedAt: p.updatedAt || now() });
    }
    insert('papers', papers);
    for (const draft of data.paperDrafts) validatePaperDraft(store, draft.state as PaperDraftState, { allowUnpublished: true });
    insert('paper_drafts', data.paperDrafts);
    for (const state of data.study) store.require('questions', state.questionId);
    insert('study', data.study, 'questionId');
    for (const a of data.attempts) {
      if (a.source === 'quick') {
        if (a.paperId !== QUICK_PAPER_ID || a.paperVersion !== 1) fail(400, 'INVALID_ATTEMPT_SOURCE', '随机单题来源与固定标识不一致');
        const roots = new Set(a.questions.map(q => q.sourceQuestionId || q.id));
        if (roots.size !== 1) fail(400, 'INVALID_ATTEMPT_SOURCE', '随机单题会话只能包含一道来源题及其子题');
      } else {
        if (a.paperId === QUICK_PAPER_ID || a.referenceViewedAt) fail(400, 'INVALID_ATTEMPT_SOURCE', '试卷会话不能使用随机单题标识或提前查看解析');
        const paper = store.get<StoredPaper>('papers', a.paperId);
        if (paper && a.paperVersion > paper.version) fail(400, 'INVALID_ATTEMPT', '作答版本高于试卷版本');
      }
      const questionIds = a.questions.map(q => q.id!);
      if (new Set(questionIds).size !== questionIds.length || Object.keys(a.answers).some(qid => !questionIds.includes(qid))) fail(400, 'INVALID_ATTEMPT', '作答题号不属于快照或重复');
      if ((a.status === 'in_progress') !== (a.submittedAt === null)) fail(400, 'INVALID_ATTEMPT', '作答状态与交卷时间不一致');
      // Historical attempts own complete snapshots. A source question may have
      // been deleted after a later paper version stopped referencing it.
      validateAttemptSnapshot(a as StoredAttempt);
      a.scoring = normalizeScoring(a.questions as Question[], a.scoring as any);
      if (a.source === 'quick' && a.scoring.enabled) fail(400, 'INVALID_ATTEMPT_SOURCE', '随机单题会话不使用试卷计分');
      a.updatedAt = a.updatedAt || a.submittedAt || a.startedAt;
    }
    insert('attempts', data.attempts);
    // Reviews remain useful study events after retention removes their attempt.
    for (const r of data.reviews) store.require('questions', r.questionId);
    insert('reviews', data.reviews);
    validateAllAssetReferences(store);
    return { mode: 'merge', counts: result };
  });
}
