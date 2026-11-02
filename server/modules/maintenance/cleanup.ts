import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CLEANUP_KINDS,
  type CleanupKind,
  type CleanupPreview,
} from '../../../shared/models/maintenance.js';
import type { Store } from '../../core/store.js';
import type { RecordTable } from '../../database/schema.js';
import { assetReferenceSources } from '../../database/asset-reference-sources.js';
import { fail } from '../../core/validation.js';
import { preserveLearningResults } from '../practice/learning-results.js';
import { archiveAttemptQuestionHistory } from '../questions/history-store.js';
import type { StoredAttempt } from '../practice/service.js';
import { recordMaintenance } from './journal.js';

export const cleanupSelectionSchema = z
  .object({
    kinds: z
      .array(z.enum(CLEANUP_KINDS))
      .min(1)
      .max(CLEANUP_KINDS.length)
      .refine((v) => new Set(v).size === v.length),
    olderThanDays: z.number().int().min(1).max(36500).default(30),
  })
  .strict();
const tables: Record<CleanupKind, RecordTable> = {
  unused_assets: 'assets',
  practice_drafts: 'attempts',
  paper_drafts: 'paper_drafts',
  document_drafts: 'document_drafts',
  ai_drafts: 'ai_workspace_drafts',
  attempt_history: 'attempts',
  question_history: 'question_history',
  focus_history: 'focus_sessions',
  ai_history: 'ai_runs',
};
interface Candidate {
  id: string;
  title: string | null;
  date: string;
  bytes: number;
  signature: string | null;
}
export function cleanupPlan(
  store: Store,
  input: z.infer<typeof cleanupSelectionSchema>,
  at = new Date(),
) {
  const db = store.database,
    x = db.expressions,
    cutoff = new Date(at.getTime() - input.olderThanDays * 86400000).toISOString();
  const rows = new Map<CleanupKind, Candidate[]>();
  let protectedAiRuns = 0;
  for (const kind of [...input.kinds].sort()) {
    const table = tables[kind];
    let query = db.query.selectFrom(table);
    const date =
      kind === 'unused_assets' || kind === 'ai_history'
        ? 'createdAt'
        : kind === 'attempt_history' || kind === 'question_history'
          ? 'submittedAt'
          : 'updatedAt';
    query = query.where(x.field('data', date), '<', cutoff);
    if (kind === 'unused_assets') {
      db.projections.ensure(assetReferenceSources);
      query = query.where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_references as r')
              .select('r.asset_id')
              .whereRef('r.asset_id', '=', `${table}.id`),
          ),
        ),
      );
    }
    if (kind === 'practice_drafts')
      query = query
        .where(x.field('data', 'status'), '=', 'in_progress')
        .where((eb) =>
          eb.or([
            eb(x.field('data', 'practiceMode'), 'is', null),
            eb(x.field('data', 'practiceMode'), '!=', 'exam'),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb(x.nestedField('data', ['practiceTiming', 'running']), 'is', null),
            eb(x.nestedField('data', ['practiceTiming', 'running']), '=', 0),
          ]),
        );
    if (kind === 'attempt_history' || kind === 'focus_history')
      query = query.where(x.field('data', 'status'), '=', 'submitted');
    if (kind === 'ai_history') {
      query = query.where(x.field('data', 'status'), 'in', ['completed', 'failed', 'cancelled']);
      const old = Number(
        db.one(query.select((eb) => eb.fn.countAll<number>().as('count')))?.count || 0,
      );
      // Textbook batches and feedback evidence have a durable owner. Independent
      // advice may be discarded without removing a job's resumable candidate data.
      query = query
        .where(x.field('data', 'jobId'), 'is', null)
        .where(x.field('data', 'batchId'), 'is', null)
        .where(x.field('data', 'feedbackId'), 'is', null);
      protectedAiRuns =
        old -
        Number(db.one(query.select((eb) => eb.fn.countAll<number>().as('count')))?.count || 0);
    }
    rows.set(
      kind,
      db.all(
        query
          .select('id')
          .select([
            x.field<string>('data', date).as('date'),
            x
              .field<string | null>(
                'data',
                kind === 'unused_assets'
                  ? 'filename'
                  : kind === 'practice_drafts' || kind === 'attempt_history'
                    ? 'paperTitle'
                    : 'title',
              )
              .as('title'),
            db.logicalBytes('data').as('bytes'),
            db.recordFingerprint('data').as('signature'),
          ])
          .orderBy('id'),
      ),
    );
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ input, cutoff: cutoff.slice(0, 10), rows: [...rows] }))
    .digest('hex');
  const items = [...rows].map(([kind, values]) => ({
    kind,
    count: values.length,
    bytes: values.reduce((n, r) => n + r.bytes, 0),
    samples: values.slice(0, 8).map((r) => ({ id: r.id, title: r.title || r.id, date: r.date })),
  }));
  const preview: CleanupPreview = {
    fingerprint,
    selection: input,
    cutoff,
    total: items.reduce((n, r) => n + r.count, 0),
    logicalBytes: items.reduce((n, r) => n + r.bytes, 0),
    items,
    protectedAiRuns,
  };
  return { rows, preview };
}
export function executeCleanup(
  store: Store,
  input: z.infer<typeof cleanupSelectionSchema>,
  fingerprint: string,
  at = new Date(),
) {
  return store.transaction(() => {
    const plan = cleanupPlan(store, input, at);
    if (plan.preview.fingerprint !== fingerprint)
      fail(409, 'MAINTENANCE_PREVIEW_STALE', '数据或引用已变化，请重新预览后确认清理');
    for (const [kind, rows] of plan.rows)
      for (const row of rows) {
        if (kind === 'attempt_history') {
          const attempt = store.require<StoredAttempt>('attempts', row.id);
          preserveLearningResults(store, attempt, { trim: false, create: false });
          archiveAttemptQuestionHistory(store, attempt);
        }
        store.database.deleteRecord(tables[kind], row.id);
      }
    recordMaintenance(store, {
      kind: 'cleanup',
      summary: '按预览清理旧记录与未引用资源',
      count: plan.preview.total,
    });
    return { ok: true as const, ...plan.preview };
  });
}
