import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Store, now, nextStamp } from '../../core/store.js';
import { parse, id, fail } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import { getId } from '../../http/request.js';
import {
  freezePracticeTiming,
  practiceTimingInputSchema,
  updatePracticeTiming,
} from '../practice/practice-timing.js';
import type { FocusSession, FocusSummary } from '../../../shared/models/focus-review.js';
import { actFocus, createFocus, focusView, saveFocus } from './service.js';
import { createFocusSchema, focusActionSchema } from './schema.js';

export function registerFocusRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/focus-sessions', async (request) => {
    const input = parse(
      z
        .object({
          page: paginationFields.page.default(1),
          pageSize: paginationFields.pageSize.default(10),
          paperId: id.optional(),
          status: z.enum(['in_progress', 'submitted']).optional(),
        })
        .strict(),
      request.query,
    );
    const db = store.database,
      x = db.expressions;
    let query = db.query
      .selectFrom('focus_sessions')
      .where(x.field('data', 'paperId'), input.paperId ? '=' : 'is', input.paperId || null);
    if (input.status) query = query.where(x.field('data', 'status'), '=', input.status);
    const total = Number(
      db.one(query.select((eb) => eb.fn.countAll<number>().as('count')))?.count || 0,
    );
    const items = db
      .all(
        query
          .select(x.field<string>('data', 'summary').as('summary'))
          .orderBy(x.field('data', 'updatedAt'), 'desc')
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
      )
      .map((row) => JSON.parse(row.summary) as FocusSummary);
    return { items, total, page: input.page, pageSize: input.pageSize };
  });
  app.post('/api/focus-sessions', async (request, reply) =>
    reply.code(201).send(focusView(createFocus(store, parse(createFocusSchema, request.body)))),
  );
  app.get('/api/focus-sessions/:id', async (request) =>
    focusView(store.require<FocusSession>('focus_sessions', getId(request))),
  );
  app.put('/api/focus-sessions/:id/current', async (request) =>
    focusView(
      actFocus(
        store,
        store.require<FocusSession>('focus_sessions', getId(request)),
        parse(focusActionSchema, request.body),
      ),
    ),
  );
  app.post('/api/focus-sessions/:id/timing', async (request) => {
    const session = store.require<FocusSession>('focus_sessions', getId(request));
    updatePracticeTiming(
      store,
      session,
      parse(practiceTimingInputSchema, request.body),
      'focus_sessions',
    );
    saveFocus(store, session);
    return {
      status: session.status,
      practiceTiming: session.practiceTiming,
      elapsedSeconds: session.elapsedSeconds,
    };
  });
  app.post('/api/focus-sessions/:id/finish', async (request) => {
    const input = parse(z.object({ revision: z.number().int().positive() }).strict(), request.body),
      session = store.require<FocusSession>('focus_sessions', getId(request));
    if (session.status === 'submitted') return focusView(session);
    if (input.revision !== session.revision)
      fail(409, 'FOCUS_VERSION_CONFLICT', '复习进度已变化，请刷新后结束');
    session.status = 'submitted';
    session.submittedAt = now();
    session.updatedAt = nextStamp(session.updatedAt);
    session.revision++;
    freezePracticeTiming(session);
    saveFocus(store, session);
    return focusView(session);
  });
}
