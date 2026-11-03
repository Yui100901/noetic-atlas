import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Question } from '../../../shared/models/types.js';
import type {
  QuestionDraft,
  QuestionDraftDetail,
} from '../../../shared/models/question-maintenance.js';
import { makeId, nextStamp, type Store } from '../../core/store.js';
import { id, fail, parse } from '../../core/validation.js';
import { getSettings } from '../settings/service.js';
import {
  createQuestionDraftSchema,
  updateQuestionDraftSchema,
  deleteQuestionDraftSchema,
  questionDraftQuerySchema,
  validateQuestionDraftState,
} from './maintenance-schema.js';
import { questionDraftRetentionCandidates } from './maintenance-retention.js';

const paramsSchema = z.object({ id }).strict();
const sourceStamp = (source?: Question) => source?.updatedAt || source?.createdAt || null;
function detail(store: Store, draft: QuestionDraft): QuestionDraftDetail {
  const source = draft.questionId ? store.get<Question>('questions', draft.questionId) : undefined;
  return {
    ...draft,
    conflict: !!draft.questionId && (!source || sourceStamp(source) !== draft.baseUpdatedAt),
  };
}
export function requireQuestionDraftVersion(
  store: Store,
  draftId: string,
  expected: string,
  questionId: string | null,
) {
  const draft = store.require<QuestionDraft>('question_drafts', draftId);
  if (draft.updatedAt !== expected)
    fail(
      409,
      'QUESTION_DRAFT_VERSION_CONFLICT',
      '这份题目草稿已被修改，请保留当前内容并重新选择草稿',
    );
  if (draft.questionId !== questionId)
    fail(409, 'QUESTION_DRAFT_CONTEXT_MISMATCH', '草稿不属于本次编辑的题目，请重新选择');
  return draft;
}
export function registerQuestionDraftRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/question-drafts', async (request) => {
    const { questionId, page, pageSize } = parse(questionDraftQuerySchema, request.query),
      d = store.database,
      x = d.expressions;
    let base = d.query.selectFrom('question_drafts as draft');
    base = questionId
      ? base.where(x.field('draft.data', 'questionId'), '=', questionId)
      : base.where(x.field('draft.data', 'questionId'), 'is', null);
    const total = Number(
      d.one(base.select((eb) => eb.fn.countAll<number>().as('total')))?.total || 0,
    );
    const rows = d.all(
      base
        .leftJoin('questions as source', (join) =>
          join.on((eb) => eb('source.id', '=', x.field<string>('draft.data', 'questionId'))),
        )
        .select([
          'draft.id',
          'source.id as sourceId',
          x.field<string | null>('draft.data', 'questionId').as('questionId'),
          x.field<string | null>('draft.data', 'baseUpdatedAt').as('baseUpdatedAt'),
          x.nestedField<string>('draft.data', ['state', 'form', 'title']).as('title'),
          x.field<string>('draft.data', 'createdAt').as('createdAt'),
          x.field<string>('draft.data', 'updatedAt').as('updatedAt'),
          x.field<string | null>('source.data', 'updatedAt').as('sourceUpdatedAt'),
          x.field<string | null>('source.data', 'createdAt').as('sourceCreatedAt'),
        ])
        .orderBy(x.field('draft.data', 'updatedAt'), 'desc')
        .orderBy('draft.id', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    );
    return {
      items: rows.map(({ sourceId, sourceUpdatedAt, sourceCreatedAt, ...row }) => ({
        ...row,
        title: row.title || '未命名题目',
        conflict:
          !!row.questionId &&
          (!sourceId || (sourceUpdatedAt || sourceCreatedAt || null) !== row.baseUpdatedAt),
      })),
      total,
      page,
      pageSize,
    };
  });
  app.get('/api/question-drafts/:id', async (request) =>
    detail(
      store,
      store.require<QuestionDraft>('question_drafts', parse(paramsSchema, request.params).id),
    ),
  );
  app.post('/api/question-drafts', async (request, reply) => {
    const input = parse(createQuestionDraftSchema, request.body);
    return store.transaction(() => {
      if (input.questionId) store.require('questions', input.questionId);
      validateQuestionDraftState(store, input.state);
      const d = store.database,
        x = d.expressions;
      let query = d.query
        .selectFrom('question_drafts')
        .select(x.field<string>('data', 'updatedAt').as('updatedAt'));
      query = input.questionId
        ? query.where(x.field('data', 'questionId'), '=', input.questionId)
        : query.where(x.field('data', 'questionId'), 'is', null);
      const stamp = nextStamp(
        d.one(query.orderBy(x.field('data', 'updatedAt'), 'desc').limit(1))?.updatedAt,
      );
      const draft = {
        ...input,
        id: makeId('question-draft'),
        createdAt: stamp,
        updatedAt: stamp,
      } as QuestionDraft;
      store.insert('question_drafts', draft.id, draft);
      for (const key of questionDraftRetentionCandidates(
        store,
        getSettings(store).maxQuestionDrafts,
        draft.id,
      ))
        store.remove('question_drafts', key);
      reply.code(201);
      return detail(store, draft);
    });
  });
  app.put('/api/question-drafts/:id', async (request) => {
    const params = parse(paramsSchema, request.params),
      input = parse(updateQuestionDraftSchema, request.body);
    return store.transaction(() => {
      const old = store.require<QuestionDraft>('question_drafts', params.id);
      requireQuestionDraftVersion(store, old.id, input.expectedUpdatedAt, old.questionId);
      validateQuestionDraftState(store, input.state);
      if (old.questionId) store.require('questions', old.questionId);
      if (
        input.baseUpdatedAt !== undefined &&
        input.baseUpdatedAt !==
          (old.questionId
            ? sourceStamp(store.require<Question>('questions', old.questionId))
            : null)
      )
        fail(409, 'QUESTION_VERSION_CONFLICT', '原题又有变化，未重定草稿基线，请重新核对');
      const saved = {
        ...old,
        state: input.state,
        ...(input.baseUpdatedAt !== undefined ? { baseUpdatedAt: input.baseUpdatedAt } : {}),
        updatedAt: nextStamp(old.updatedAt),
      } as QuestionDraft;
      store.put('question_drafts', saved.id, saved);
      return detail(store, saved);
    });
  });
  app.delete('/api/question-drafts/:id', async (request) => {
    const params = parse(paramsSchema, request.params),
      input = parse(deleteQuestionDraftSchema, request.body);
    return store.transaction(() => {
      const old = store.require<QuestionDraft>('question_drafts', params.id);
      requireQuestionDraftVersion(store, old.id, input.expectedUpdatedAt, old.questionId);
      store.remove('question_drafts', old.id);
      return { deleted: true };
    });
  });
}
