import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { id,parse } from '../../core/validation.js';
import { qualityScanCreateSchema,qualityScanProcessSchema,qualityScanQuerySchema,qualityIssueQuerySchema,qualityResolveSchema,qualityBulkResolveSchema,qualityReviewContextSchema,qualityReviewContextsSchema } from './schema.js';
import {prepareQualityReviewContext} from './review-context.js';
import {qualityQuestionPage} from './grouping.js';
import { createQualityScan,processQualityScan,requireQualityScan,cancelQualityScan,qualityScanPage,qualityIssuePage,qualityIssueDetail,resolveQualityIssue,qualityOverview } from './service.js';
const identity=(params:unknown)=>parse(id,(params as {id:string}).id);
export function registerContentQualityRoutes(app:FastifyInstance,store:Store){
  app.get('/api/content-quality/overview',async()=>qualityOverview(store));
  app.get('/api/content-quality/scans',async request=>qualityScanPage(store,parse(qualityScanQuerySchema,request.query)));
  app.post('/api/content-quality/scans',async(request,reply)=>reply.code(201).send(createQualityScan(store,parse(qualityScanCreateSchema,request.body||{}).filters)));
  app.get('/api/content-quality/scans/:id',async request=>requireQualityScan(store,identity(request.params)));
  app.post('/api/content-quality/scans/:id/process',async request=>processQualityScan(store,identity(request.params),parse(qualityScanProcessSchema,request.body||{}).batchSize));
  app.post('/api/content-quality/scans/:id/cancel',async request=>cancelQualityScan(store,identity(request.params)));
  app.get('/api/content-quality/issues',async request=>qualityIssuePage(store,parse(qualityIssueQuerySchema,request.query)));
  app.get('/api/content-quality/questions',async request=>qualityQuestionPage(store,parse(qualityIssueQuerySchema,request.query)));
  app.get('/api/content-quality/issues/:id',async request=>qualityIssueDetail(store,identity(request.params)));
  app.post('/api/content-quality/issues/:id/review-context',async request=>prepareQualityReviewContext(store,identity(request.params),parse(qualityReviewContextSchema,request.body).expectedUpdatedAt));
  app.post('/api/content-quality/review-contexts',async request=>{const input=parse(qualityReviewContextsSchema,request.body);return store.transaction(()=>({items:input.ids.map(id=>prepareQualityReviewContext(store,id,input.expectedUpdatedAt[id]!))}));});
  app.post('/api/content-quality/issues/:id/resolve',async request=>store.transaction(()=>resolveQualityIssue(store,identity(request.params),parse(qualityResolveSchema,request.body))));
  app.post('/api/content-quality/issues/resolve',async request=>{const input=parse(qualityBulkResolveSchema,request.body);return store.transaction(()=>({items:input.ids.map(id=>resolveQualityIssue(store,id,{status:input.status,note:input.note,expectedUpdatedAt:input.expectedUpdatedAt[id]!}))}));});
}
