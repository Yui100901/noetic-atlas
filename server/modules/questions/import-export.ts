/** Bulk authoring operations shared by JSON APIs and manifest package import. */
import type { PackageQuestionHashHint } from '../../../shared/packages/question-hashes.js';
import type { Question } from '../../../shared/models/types.js';
import { normalizeQuestionBlankStems } from '../../../shared/questions/blank-markers.js';
import { Store, now, nextStamp } from '../../core/store.js';
import {
  fail,
  parse,
  newQuestionEnvelopeSchema,
  pendingEnvelopeSchema,
  selectedIdsSchema,
} from '../../core/validation.js';
import { validateAssetReferences } from '../assets/service.js';
import { validateDocumentCitations } from '../library/sources.js';
import { getSettings } from '../settings/service.js';
import { captureQuestionRevision } from './revisions.js';
import type { ImportDedupOptions } from '../../../shared/models/import-dedup.js';
import { applyQuestionImport } from '../question-imports/service.js';

export function assertNewQuestionId(qid?: string) {
  if (qid && ['new', 'review', 'import', 'import-template'].includes(qid))
    fail(
      400,
      'QUESTION_ID_RESERVED',
      `题号 ${qid} 为系统操作保留，请使用其他自定义题号或省略ID自动生成`,
    );
}

export function importNewQuestionData(
  store: Store,
  raw: unknown,
  options: ImportDedupOptions = {},
  hashHints?: ReadonlyArray<PackageQuestionHashHint | undefined>,
) {
  const data = parse(newQuestionEnvelopeSchema, raw);
  const entries = data.questions.map((raw) => {
    const input = normalizeQuestionBlankStems(raw);
    assertNewQuestionId(input.id);
    return input;
  });
  return applyQuestionImport(store, entries, options, hashHints);
}

export function exportPendingQuestions(store: Store, rawIds: unknown) {
  const { ids } = parse(selectedIdsSchema, { ids: rawIds });
  const questions = ids.map((qid) => {
    const q = store.require<Question>('questions', qid);
    if (q.status !== 'pending') fail(409, 'QUESTION_NOT_PENDING', `只能导出待审核题目：${qid}`);
    return q;
  });
  return {
    format: 'learning-pending-questions' as const,
    schemaVersion: 1 as const,
    exportedAt: now(),
    questions,
  };
}

export function importPendingQuestions(store: Store, raw: unknown) {
  const data = parse(pendingEnvelopeSchema, raw);
  return store.transaction(() => {
    const entries = data.questions.map((raw) => {
      const input = normalizeQuestionBlankStems(raw);
      const q = store.require<Question>('questions', input.id!);
      if (q.status !== 'pending')
        fail(409, 'QUESTION_NOT_PENDING', `只能更新现有待审核题目：${q.id}`);
      if (q.updatedAt !== input.updatedAt)
        fail(409, 'QUESTION_VERSION_CONFLICT', `题目已被修改，未覆盖更新：${q.id}`);
      store.validateRefs(input);
      validateAssetReferences(store, input, getSettings(store));
      return {
        ...input,
        id: q.id,
        status: 'pending' as const,
        createdAt: q.createdAt || now(),
        updatedAt: nextStamp(q.updatedAt),
      };
    });
    for (const q of entries) {
      validateDocumentCitations(store, q, true);
      captureQuestionRevision(
        store,
        store.require<Question>('questions', q.id),
        q,
        'pending_import',
        '待审核题批量修订',
      );
      store.put('questions', q.id, q);
    }
    return { ok: true, updated: entries.length, items: entries.map((q) => store.question(q.id)) };
  });
}
