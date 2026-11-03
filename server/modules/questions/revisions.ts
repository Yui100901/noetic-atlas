import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Question } from '../../../shared/models/types.js';
import type {
  QuestionRevision,
  QuestionRevisionOrigin,
} from '../../../shared/models/question-maintenance.js';
import {
  questionRevisionContent,
  questionRevisionDifferences,
  questionContentEqual,
} from '../../../shared/questions/question-revisions.js';
import { makeId, now, nextStamp, type Store } from '../../core/store.js';
import { id, fail, parse, questionSchema } from '../../core/validation.js';
import { normalizeQuestionBlankStems } from '../../../shared/questions/blank-markers.js';
import { getSettings } from '../settings/service.js';
import { validateAssetReferences } from '../assets/service.js';
import { validateDocumentCitations } from '../library/sources.js';
import {
  questionRevisionSchema,
  questionRevisionQuerySchema,
  restoreQuestionRevisionSchema,
  validateQuestionMaintenanceBytes,
} from './maintenance-schema.js';
import { questionRevisionRetentionCandidates } from './maintenance-retention.js';

const questionParams = z.object({ id }).strict(),
  revisionParams = z.object({ id, revisionId: id }).strict();
const revisionFor = (store: Store, questionId: string, key: string) => {
  const item = store.require<QuestionRevision>('question_revisions', key);
  if (item.questionId !== questionId) fail(404, 'QUESTION_REVISION_NOT_FOUND', '该修订不属于本题');
  return item;
};
/** Used only by explicit content-edit paths. Import/restore of a database must
 * not turn every preserved source into a newly generated local revision. */
export function captureQuestionRevision(
  store: Store,
  previous: Question | undefined,
  next: Question,
  origin: QuestionRevisionOrigin = 'manual',
  reason = '',
  restoredFromId?: string,
) {
  const before = previous ? questionRevisionContent(previous) : undefined,
    after = questionRevisionContent(next);
  if (before && questionContentEqual(before, after)) return;
  const d = store.database,
    x = d.expressions;
  const latest = d.one(
    d.query
      .selectFrom('question_revisions')
      .select(['id', x.field<number>('data', 'sequence').as('sequence')])
      .where(x.field('data', 'questionId'), '=', next.id)
      .orderBy(x.field('data', 'sequence'), 'desc')
      .limit(1),
  );
  let sequence = latest?.sequence || 0;
  const write = (
    source: Question,
    mode: QuestionRevisionOrigin,
    changedFields: string[],
    note: string,
    restored?: string,
  ) => {
    const revision: QuestionRevision = {
      id: makeId('question-revision'),
      questionId: next.id,
      sequence: ++sequence,
      content: questionRevisionContent(source),
      origin: mode,
      reason: note,
      changedFields,
      createdAt: now(),
      sourceUpdatedAt: source.updatedAt || source.createdAt || now(),
      ...(restored ? { restoredFromId: restored } : {}),
    };
    questionRevisionSchema.parse(revision);
    validateQuestionMaintenanceBytes(revision);
    store.insert('question_revisions', revision.id, revision);
    return revision.id;
  };
  // Capture a pre-existing source on its first tracked edit. A malformed choice
  // can be recorded safely and repaired; only a real restore validates answers.
  if (previous && !latest) write(previous, 'baseline', [], '首次编辑前的原题');
  const saved = write(
    next,
    previous ? origin : 'baseline',
    before ? questionRevisionDifferences(before, after).map((item) => item.field) : [],
    reason,
    restoredFromId,
  );
  for (const key of questionRevisionRetentionCandidates(
    store,
    getSettings(store).maxQuestionRevisions,
    saved,
  ))
    store.remove('question_revisions', key);
}
export function registerQuestionRevisionRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/questions/:id/revisions', async (request) => {
    const { id: questionId } = parse(questionParams, request.params),
      { page, pageSize } = parse(questionRevisionQuerySchema, request.query);
    const d = store.database,
      x = d.expressions,
      base = d.query
        .selectFrom('question_revisions')
        .where(x.field('data', 'questionId'), '=', questionId);
    if (!d.one(d.query.selectFrom('questions').select('id').where('id', '=', questionId)))
      fail(404, 'NOT_FOUND', '记录不存在');
    const total = Number(
      d.one(base.select((eb) => eb.fn.countAll<number>().as('total')))?.total || 0,
    );
    const rows = d.all(
      base
        .select([
          'id',
          ...(
            [
              'questionId',
              'sequence',
              'origin',
              'reason',
              'createdAt',
              'sourceUpdatedAt',
              'restoredFromId',
            ] as const
          ).map((key) => x.field('data', key).as(key)),
          x.field<string>('data', 'changedFields').as('changedFields'),
          x.nestedField<string>('data', ['content', 'title']).as('title'),
        ])
        .orderBy(x.field('data', 'sequence'), 'desc')
        .orderBy('id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    );
    return {
      items: rows.map((row) => ({
        ...row,
        changedFields: JSON.parse(row.changedFields),
        ...(row.restoredFromId ? {} : { restoredFromId: undefined }),
      })),
      total,
      page,
      pageSize,
    };
  });
  app.get('/api/questions/:id/revisions/:revisionId', async (request) => {
    const params = parse(revisionParams, request.params),
      current = store.require<Question>('questions', params.id),
      revision = revisionFor(store, params.id, params.revisionId);
    return {
      ...revision,
      title: revision.content.title,
      diff: questionRevisionDifferences(revision.content, questionRevisionContent(current)),
    };
  });
  app.post('/api/questions/:id/revisions/:revisionId/restore', async (request) => {
    const params = parse(revisionParams, request.params),
      input = parse(restoreQuestionRevisionSchema, request.body);
    return store.transaction(() => {
      const old = store.require<Question>('questions', params.id),
        revision = revisionFor(store, params.id, params.revisionId);
      if ((old.updatedAt || old.createdAt) !== input.expectedUpdatedAt)
        fail(409, 'QUESTION_VERSION_CONFLICT', '原题已更新，请重新核对差异后再恢复');
      const value = normalizeQuestionBlankStems(
        parse(questionSchema, {
          ...revision.content,
          id: old.id,
          status: old.status,
          createdAt: old.createdAt,
          updatedAt: nextStamp(old.updatedAt),
        }),
      ) as Question;
      store.validateRefs(value);
      validateAssetReferences(store, value, getSettings(store));
      validateDocumentCitations(store, value, true);
      captureQuestionRevision(
        store,
        old,
        value,
        'restore',
        input.reason || `恢复修订 #${revision.sequence}`,
        revision.id,
      );
      store.put('questions', value.id, value);
      return store.question(value.id);
    });
  });
}
