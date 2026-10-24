import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PaperDraft, PaperDraftState } from '../../../shared/practice/paper-drafts.js';
import type { Question } from '../../../shared/models/types.js';
import { getSettings } from '../settings/service.js';
import { paperDraftRetentionCandidates } from './paper-draft-retention.js';
export { paperDraftRetentionCandidates } from './paper-draft-retention.js';
import { id, fail, parse, types } from '../../core/validation.js';
import { makeId, nextStamp, type Store } from '../../core/store.js';

const ids = z.array(id).max(500).refine(value => new Set(value).size === value.length, '题号不可重复');
const points = z.record(types, z.number().finite().min(0).max(10000));
const reference = z.string().max(160);
const draftFilters = z.object({search:z.string().max(1000).optional(),paperId:reference.optional(),domainId:reference.optional(),categoryId:reference.optional(),tagIds:ids.optional(),tagMode:z.enum(['all','any']).optional(),type:z.string().max(40).optional(),types:z.array(types).max(7).optional(),difficulty:z.string().max(10).optional(),depth:z.string().max(10).optional(),frequency:z.string().max(10).optional(),collection:z.string().max(20).optional(),status:z.string().max(20).optional(),favorite:z.boolean().optional(),wrong:z.boolean().optional(),due:z.boolean().optional(),difficultyMin:z.number().int().min(1).max(4).optional(),difficultyMax:z.number().int().min(1).max(4).optional(),frequencyMin:z.number().int().min(0).max(3).optional()}).strict();
export const paperDraftStateSchema = z.object({
  title: z.string().max(200), description: z.string().max(4000), mode: z.enum(['manual','random']),
  organization: z.enum(['domain','other']), domainId: z.string().max(160), questionIds: z.array(id).max(50_000).refine(value=>new Set(value).size===value.length,'题集题号不可重复'),
  filters: draftFilters, random: draftFilters,
  count: z.number().finite().min(0).max(500), enabled: z.boolean(), total: z.number().finite().min(0).max(10000),
  objectivePercent: z.number().finite().min(0).max(100), pointsByType: points,
  overrides: z.record(id, z.number().finite().min(0).max(10000)), autoTotal: z.boolean(),
}).strict();
export const paperDraftSchema = z.object({ id, context: z.string().min(1).max(160), createdAt: z.string().datetime({offset:true}), updatedAt: z.string().datetime({offset:true}), state: paperDraftStateSchema }).strict();

export function validatePaperDraft(store: Store, state: PaperDraftState, options: { allowUnpublished?: boolean; existingQuestionIds?: string[] } = {}) {
  if (state.domainId) store.require('domains', state.domainId);
  for (const questionId of state.questionIds) {
    const question = store.require<Question>('questions', questionId);
    if (question.status !== 'published' && !options.allowUnpublished && !options.existingQuestionIds?.includes(questionId)) fail(400,'UNPUBLISHED_DRAFT_QUESTION',`组卷草稿只能新选择已发布题目：${questionId}`);
  }
  for (const filters of [state.filters, state.random]) {
    if (typeof filters.domainId === 'string' && filters.domainId) store.require('domains', filters.domainId);
    if (typeof filters.categoryId === 'string' && filters.categoryId) store.require('categories', filters.categoryId);
    if (typeof filters.paperId === 'string' && filters.paperId) store.require('papers', filters.paperId);
    if (Array.isArray(filters.tagIds)) for (const tag of filters.tagIds) { if (typeof tag !== 'string') fail(400,'INVALID_REFERENCE','标签引用格式无效'); store.require('tags',tag); }
  }
}
export function registerPaperDraftRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/paper-drafts', async request => {
    const { context } = parse(z.object({context:z.string().min(1).max(160).optional()}).strict(),request.query);
    return store.all<PaperDraft>('paper_drafts').filter(d=>!context||d.context===context).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id));
  });
  app.post('/api/paper-drafts', async (request,reply) => {
    const input = parse(z.object({context:z.string().min(1).max(160),state:paperDraftStateSchema}).strict(),request.body);
    validatePaperDraft(store,input.state as PaperDraftState);
    return store.transaction(()=>{
      const latest=store.all<PaperDraft>('paper_drafts').map(draft=>draft.updatedAt).sort().at(-1);
      const stamp=nextStamp(latest), draft:PaperDraft={id:makeId('paper-draft'),context:input.context,createdAt:stamp,updatedAt:stamp,state:input.state as PaperDraftState};
      store.put('paper_drafts',draft.id,draft);
      for(const old of paperDraftRetentionCandidates(store,getSettings(store).maxPaperDrafts,draft.id)) store.remove('paper_drafts',old.id);
      reply.code(201); return draft;
    });
  });
  app.put('/api/paper-drafts/:id',async request=>{
    const params=parse(z.object({id}),request.params), input=parse(z.object({expectedUpdatedAt:z.string().datetime({offset:true}),state:paperDraftStateSchema}).strict(),request.body);
    return store.transaction(()=>{
      const previous=store.require<PaperDraft>('paper_drafts',params.id);
      if(previous.updatedAt!==input.expectedUpdatedAt) fail(409,'PAPER_DRAFT_VERSION_CONFLICT','这份组卷草稿已在其他页面修改，请保留当前内容，重新选择草稿后再继续。');
      // A question may be archived after authoring started. Preserve the
      // existing selection while the user removes/replaces it; never allow a
      // new unpublished question to be added through a draft write.
      validatePaperDraft(store,input.state as PaperDraftState,{existingQuestionIds:previous.state.questionIds});
      const draft={...previous,state:input.state as PaperDraftState,updatedAt:nextStamp(previous.updatedAt)}; store.put('paper_drafts',draft.id,draft); return draft;
    });
  });
  app.delete('/api/paper-drafts/:id',async request=>{const params=parse(z.object({id}),request.params);store.remove('paper_drafts',params.id);return {deleted:true};});
}
