import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AI_WORKSPACE_DRAFT_LIMIT, type AiWorkspaceDraft, type AiWorkspaceDraftKind } from '../../../shared/ai/workspace-drafts.js';
import { makeId,nextStamp,type Store } from '../../core/store.js';
import { fail,id,parse } from '../../core/validation.js';
import { aiWorkspaceDraftCreateSchema,aiWorkspaceDraftDeleteSchema,aiWorkspaceDraftQuerySchema,aiWorkspaceDraftSchema,aiWorkspaceDraftUpdateSchema } from './workspace-draft-schema.js';

function scoped(store:Store,kind:AiWorkspaceDraftKind,contextId:string|null){
 const db=store.database,field=db.expressions.field.bind(db.expressions);
 return db.query.selectFrom('ai_workspace_drafts').where(field('data','kind'),'=',kind).where(field('data','contextId'),contextId===null?'is':'=',contextId).orderBy(field('data','updatedAt'),'desc').orderBy('id','desc');
}
function version(draft:AiWorkspaceDraft,expected:string){if(draft.updatedAt!==expected)fail(409,'AI_WORKSPACE_DRAFT_VERSION_CONFLICT','这份AI工作台草稿已在其他页面修改，请保留当前内容并另存为新草稿。');}
export function listAiWorkspaceDrafts(store:Store,kind:AiWorkspaceDraftKind,contextId:string|null){return store.database.all(scoped(store,kind,contextId).select('data').limit(AI_WORKSPACE_DRAFT_LIMIT)).map(row=>JSON.parse(row.data) as AiWorkspaceDraft);}
function trim(store:Store,kind:AiWorkspaceDraftKind,contextId:string|null){for(const row of store.database.all(scoped(store,kind,contextId).select('id').limit(Number.MAX_SAFE_INTEGER).offset(AI_WORKSPACE_DRAFT_LIMIT)))store.remove('ai_workspace_drafts',row.id);}
export function registerAiWorkspaceDraftRoutes(app:FastifyInstance,store:Store){
 app.get('/api/ai/workspace-drafts',async request=>{const {kind,contextId}=parse(aiWorkspaceDraftQuerySchema,request.query);return listAiWorkspaceDrafts(store,kind,contextId);});
 app.get('/api/ai/workspace-drafts/:id',async request=>store.require<AiWorkspaceDraft>('ai_workspace_drafts',parse(z.object({id}).strict(),request.params).id));
 app.post('/api/ai/workspace-drafts',async(request,reply)=>{const input=parse(aiWorkspaceDraftCreateSchema,request.body);return store.transaction(()=>{
  if(input.kind==='document-job'&&!store.database.getRecord('ai_import_jobs',input.contextId!))fail(404,'AI_DOCUMENT_JOB_NOT_FOUND','教材任务已不存在，不能为已删除任务重新保存草稿。');
  const latest=store.database.one(scoped(store,input.kind,input.contextId).select(store.database.expressions.field<string>('data','updatedAt').as('stamp')).limit(1));
  const stamp=nextStamp(latest?.stamp),draft:AiWorkspaceDraft={...input,id:makeId('ai-draft'),createdAt:stamp,updatedAt:stamp};store.insert('ai_workspace_drafts',draft.id,draft);trim(store,draft.kind,draft.contextId);reply.code(201);return draft;
 });});
 app.put('/api/ai/workspace-drafts/:id',async request=>{const params=parse(z.object({id}).strict(),request.params),input=parse(aiWorkspaceDraftUpdateSchema,request.body);return store.transaction(()=>{
  const previous=store.require<AiWorkspaceDraft>('ai_workspace_drafts',params.id);version(previous,input.expectedUpdatedAt);
  if(previous.kind==='document-job'&&!store.database.getRecord('ai_import_jobs',previous.contextId!))fail(404,'AI_DOCUMENT_JOB_NOT_FOUND','教材任务已不存在，请保留草稿内容并重新建立任务。');
  const latest=store.database.one(scoped(store,previous.kind,previous.contextId).select(store.database.expressions.field<string>('data','updatedAt').as('stamp')).limit(1));
  const draft=parse(aiWorkspaceDraftSchema,{...previous,state:input.state,updatedAt:nextStamp(latest?.stamp||previous.updatedAt)});store.put('ai_workspace_drafts',draft.id,draft);trim(store,draft.kind,draft.contextId);return draft;
 });});
 app.delete('/api/ai/workspace-drafts/:id',async request=>{const params=parse(z.object({id}).strict(),request.params),input=parse(aiWorkspaceDraftDeleteSchema,request.body);return store.transaction(()=>{version(store.require<AiWorkspaceDraft>('ai_workspace_drafts',params.id),input.expectedUpdatedAt);store.remove('ai_workspace_drafts',params.id);return{deleted:true};});});
}
