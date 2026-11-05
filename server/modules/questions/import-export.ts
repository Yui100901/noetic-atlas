/** Bulk authoring operations shared by JSON APIs and manifest package import. */
import type { Question } from '../../../shared/models/types.js';
import { normalizeQuestionBlankStems } from '../../../shared/questions/blank-markers.js';
import { Store, makeId, now, nextStamp } from '../../core/store.js';
import { fail, parse, newQuestionEnvelopeSchema, pendingEnvelopeSchema, selectedIdsSchema } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/service.js';
import { validateDocumentCitations } from '../library/sources.js';
import { getSettings } from '../settings/service.js';
import { captureQuestionRevision } from './revisions.js';

export function assertNewQuestionId(qid?: string) {
  if (qid && ['new', 'review', 'import', 'import-template'].includes(qid)) fail(400, 'QUESTION_ID_RESERVED', `题号 ${qid} 为系统操作保留，请使用其他自定义题号或省略ID自动生成`);
}

export function importNewQuestionData(store: Store, raw: unknown) {
  const data = parse(newQuestionEnvelopeSchema, raw);
  return store.transaction(() => {
    const stamp = now();
    const entries = data.questions.map(raw => {
      const input = normalizeQuestionBlankStems(raw);
      assertNewQuestionId(input.id);
      store.validateRefs(input);
      validateAssetReferences(store, input);
      const qid = input.id || makeId('q');
      if (store.get('questions', qid)) fail(409, 'ID_EXISTS', `题号已存在，未覆盖现有题目：${qid}`);
      return { ...input, id: qid, status: 'pending' as const, createdAt: stamp, updatedAt: stamp };
    });
    if (new Set(entries.map(q => q.id)).size !== entries.length) fail(409, 'ID_EXISTS', '生成的题号冲突，请重试');
    const sourceCache = new Map();
    for (const q of entries) { validateDocumentCitations(store, q, true, sourceCache); store.insert('questions', q.id, q); }
    return { added: entries.length, items: entries.map(q => store.question(q.id)) };
  });
}

export function exportPendingQuestions(store: Store, rawIds: unknown) {
  const { ids } = parse(selectedIdsSchema, { ids: rawIds });
  const questions = ids.map(qid => {
    const q = store.require<Question>('questions', qid);
    if (q.status !== 'pending') fail(409, 'QUESTION_NOT_PENDING', `只能导出待审核题目：${qid}`);
    return q;
  });
  return { format: 'learning-pending-questions' as const, schemaVersion: 1 as const, exportedAt: now(), questions };
}

export function importPendingQuestions(store: Store, raw: unknown) {
  const data = parse(pendingEnvelopeSchema, raw);
  return store.transaction(() => {
    const entries = data.questions.map(raw => {
      const input = normalizeQuestionBlankStems(raw);
      const q = store.require<Question>('questions', input.id!);
      if (q.status !== 'pending') fail(409, 'QUESTION_NOT_PENDING', `只能更新现有待审核题目：${q.id}`);
      if (q.updatedAt !== input.updatedAt) fail(409, 'QUESTION_VERSION_CONFLICT', `题目已被修改，未覆盖更新：${q.id}`);
      store.validateRefs(input); validateAssetReferences(store, input, getSettings(store));
      return { ...input, id: q.id, status: 'pending' as const, createdAt: q.createdAt || now(), updatedAt: nextStamp(q.updatedAt) };
    });
    for (const q of entries) {
      validateDocumentCitations(store, q, true);
      captureQuestionRevision(store, store.require<Question>('questions', q.id), q, 'pending_import', '待审核题批量修订');
      store.put('questions', q.id, q);
    }
    return { ok: true, updated: entries.length, items: entries.map(q => store.question(q.id)) };
  });
}
