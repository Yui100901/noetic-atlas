import type { FastifyInstance, FastifySchema } from 'fastify';
import { z } from 'zod';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import * as validation from '../core/validation.js';
import { settingsSchema } from '../modules/settings/service.js';
import { configurationSchema, configurationPreviewInputSchema, configurationImportInputSchema, configurationExportQuerySchema, configurationPreviewSchema, configurationImportResultSchema } from '../modules/settings/configuration.js';
import { assetInputSchema } from '../modules/assets/schema.js';
import * as ai from '../modules/ai/schema.js';
import { paperDraftStateSchema, paperDraftSchema } from '../modules/practice/paper-drafts.js';
import { paginationFields } from '../core/pagination.js';
import { vocabularyQuerySchema } from '../modules/questions/vocabulary.js';

interface RouteEntry { method: string; url: string; schema?: FastifySchema }
type JsonSchema = Record<string, any>;
const object: JsonSchema = { type: 'object', additionalProperties: true };
const errorSchema: JsonSchema = { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code','message'], properties: { code: {type:'string'}, message: {type:'string'}, details: {} } } } };
const aiProgressEvent: JsonSchema = { oneOf: [
  { type: 'object', required: ['type','stage','message'], properties: { type: { const: 'status' }, stage: { type: 'string' }, message: { type: 'string' }, current: { type: 'number' }, total: { type: 'number' } } },
  { type: 'object', required: ['type','text'], properties: { type: { const: 'delta' }, text: { type: 'string', description: '模型生成的答案片段，不包含模型的私有推理内容。结构化结果须等待 result 事件验证完成。' } } },
  { type: 'object', required: ['type','result'], properties: { type: { const: 'result' }, result: object } },
  { type: 'object', required: ['type','error'], properties: { type: { const: 'error' }, error: { type: 'object', required: ['code','message'], properties: { code: { type: 'string' }, message: { type: 'string' }, statusCode: { type: 'integer' } } } } },
] };
const streamingAiRoute = (method: string, url: string) => method === 'POST' && (/^\/api\/ai\/(?:test|explain|grade|import|review|paper-plan)$/.test(url) || url === '/api/attempts/:id/ai-review');
const id = validation.id;
const toJson = (schema: z.ZodType): JsonSchema => { const {$schema: _schema,...result} = z.toJSONSchema(schema,{io:'input',unrepresentable:'any'}) as JsonSchema; return result; };
const paged = (item: JsonSchema): JsonSchema => ({ anyOf: [{type:'array',items:item},{type:'object',required:['items','total','page','pageSize'],properties:{items:{type:'array',items:item},total:{type:'integer'},page:{type:'integer'},pageSize:{type:'integer'}}}] });
const {key:_writeOnlyKey,clearKey:_clearKey,...aiPublicFields}=ai.aiSettingsSchema.shape;
const aiPublicSettingsSchema=z.object({...aiPublicFields,hasKey:z.boolean()});
const aiRunOutput: JsonSchema = {type:'object',required:['id','kind','status','createdAt','model','questionIds','warnings','result'],properties:{id:{type:'string'},kind:{enum:['explain','grade','import','review','paper_plan']},status:{const:'completed'},createdAt:{type:'string',format:'date-time'},model:{type:'string'},warnings:{type:'array',items:{type:'string'}},questionIds:{type:'array',items:{type:'string'}},attemptId:{type:'string'},createdPaperId:{type:'string'},appliedAt:{type:'string',format:'date-time'},result:{oneOf:[toJson(ai.explanationSchema),toJson(ai.gradeResultSchema),toJson(ai.importResultSchema),toJson(ai.reviewResultSchema.safeExtend({approvedIds:z.array(id)})),toJson(ai.aiPaperPlanOutputSchema.safeExtend({requestedCount:z.number().int(),candidateCount:z.number().int(),candidates:z.array(z.object({id,title:z.string(),type:z.string()}))}))]}}};
const paperOutput: JsonSchema = {type:'object',properties:{...toJson(validation.paperInputSchema).properties,id:{type:'string'},questionCount:{type:'integer'},answerCount:{type:'integer'},version:{type:'integer'},archived:{type:'boolean'},createdAt:{type:'string',format:'date-time'},updatedAt:{type:'string',format:'date-time'},scoring:toJson(validation.storedScoringSchema),questions:{type:'array',items:{...object,description:'ExamQuestion：题干、选项、难度与分值；交卷前不含参考答案'}}}};
const attemptOutput: JsonSchema = {type:'object',properties:{id:{type:'string'},paperId:{type:'string'},paperTitle:{type:'string'},paperVersion:{type:'integer'},source:{enum:['paper','quick']},status:{enum:['in_progress','submitted']},practiceMode:{enum:['practice','exam']},durationMinutes:{type:'integer'},deadlineAt:{type:['string','null'],format:'date-time'},startedAt:{type:'string',format:'date-time'},submittedAt:{type:['string','null'],format:'date-time'},updatedAt:{type:'string',format:'date-time'},elapsedSeconds:{type:'integer',minimum:0},autoSubmitted:{type:'boolean'},answers:{type:'object',additionalProperties:toJson(validation.answerSchema)},questions:{type:'array',items:object},scoring:toJson(validation.storedScoringSchema),objectiveScore:{type:'number'},objectiveMax:{type:'number'},subjectiveScore:{type:'number'},subjectiveMax:{type:'number'},totalScore:{type:['number','null']},pendingSubjectiveCount:{type:'integer'},gradingStatus:{enum:['pending','partial','complete','not_applicable']}}};
const shareSelection=z.object({kind:z.enum(['questions','paper','bank']),id:id.optional(),ids:z.array(id).min(1).max(50000).optional(),filters:z.record(z.string(),z.unknown()).optional()}).strict();
const pathBodies: Record<string,z.ZodType> = {
  '/api/questions': validation.questionSchema, '/api/domains': validation.domainSchema, '/api/categories': validation.categorySchema,
  '/api/tags': validation.tagSchema, '/api/documents': validation.documentSchema, '/api/question-banks': validation.questionBankSchema,
  '/api/papers': validation.paperInputSchema, '/api/papers/preview': validation.paperInputSchema,
  '/api/questions/bulk-import': validation.bulkQuestionImportSchema, '/api/questions/review': validation.questionReviewSchema,
  '/api/ai/settings': ai.aiSettingsSchema, '/api/ai/paper-plan': ai.aiPaperPlanInputSchema,
  '/api/ai/import': z.object({text:z.string().min(1).max(400000),sourceName:z.string().optional(),categoryIds:z.array(id).default([]),tagIds:z.array(id).default([]),count:z.number().int().min(1).max(50).default(20)}),
  '/api/ai/explain': z.object({questionId:id,partId:id.optional()}),
  '/api/ai/grade': z.union([z.object({attemptId:id,questionIds:ai.aiIds.optional()}),z.object({questionId:id,answer:z.string().max(100000),maxPoints:z.number().min(.01).max(1000).optional()})]),
  '/api/assets': assetInputSchema,
  '/api/sharing/export':shareSelection,'/api/sharing/export-document':shareSelection,'/api/sharing/preview':z.object({data:z.unknown()}).strict(),'/api/sharing/import':z.object({data:z.unknown(),confirmed:z.literal(true),expectedFingerprint:z.string().length(64).optional()}).strict(),
  '/api/import':z.object({data:z.unknown(),mode:z.literal('merge')}).strict(),
  '/api/settings/import/preview': configurationPreviewInputSchema, '/api/settings/import': configurationImportInputSchema,
  '/api/settings': z.object({settings:settingsSchema,confirmedRetention:z.literal(true).optional(),expectedRetention:z.object({drafts:z.number().int(),history:z.number().int(),total:z.number().int(),authoring:z.number().int().optional()}).optional()}),
};
const summaries: Record<string,string> = {questions:'题目',domains:'知识领域',categories:'分类',tags:'标签',documents:'学习资料','question-banks':'题库集合',papers:'练习卷',attempts:'作答记录',study:'学习状态',reviews:'复习事件',settings:'系统配置',assets:'文件资源',ai:'AI辅助',share:'内容分享',data:'数据迁移',backup:'数据备份',health:'健康检查',bootstrap:'初始信息','paper-drafts':'组卷草稿',exams:'考试会话'};
function bodyFor(method:string,url:string): JsonSchema|undefined {
  if (!['POST','PUT','PATCH'].includes(method)) return undefined;
  if (/^\/api\/(?:exams\/sync|attempts\/:id\/(?:sync|reveal))$/.test(url)) return undefined;
  if (url==='/api/papers/:id/attempts')return toJson(z.object({mode:z.enum(['practice','exam']).optional(),durationMinutes:z.number().int().min(1).max(1440).optional()}).strict());
  if (url==='/api/paper-drafts'&&method==='POST')return toJson(z.object({context:z.string().min(1).max(160),state:paperDraftStateSchema}).strict());
  if (url==='/api/paper-drafts/:id'&&method==='PUT')return toJson(z.object({expectedUpdatedAt:z.string().datetime({offset:true}),state:paperDraftStateSchema}).strict());
  if (/\/ai\/runs\/:id\/paper$/.test(url)) return toJson(ai.aiPaperPlanApplySchema);
  if (/\/ai\/runs\/:id\/apply$/.test(url)) return toJson(ai.applySchema);
  if (url==='/api/attempts/:id/submit') return toJson(z.object({answers:validation.answersSchema.optional()}).strict());
  if (url === '/api/attempts/:id' || /\/attempts\/:id\/save$/.test(url)) return toJson(z.object({answers:validation.answersSchema}).strict());
  if (/\/attempts\/:id\/(?:review|grade)$/.test(url)) return toJson(validation.scoreSchema);
  if (/\/study\/:id$/.test(url)) return toJson(validation.studySchema);
  const schema = pathBodies[url] || (method==='PUT'?pathBodies[url.replace(/\/:id$/,'')]:undefined);
  return schema?toJson(schema):object;
}
/** The registered route catalog is the source of paths. Shared Zod validators
 * supply input shapes; the transform does not add a second runtime validator. */
function documentationSchema(entry:RouteEntry):FastifySchema {
  const {method,url}=entry; const parts=url.split('/').filter(Boolean); const area=parts[1]||'api';
  const label=summaries[area]||area; const list=method==='GET'&&!url.includes('/:')&&['questions','domains','categories','tags','documents','question-banks','papers','attempts','study','reviews','assets'].includes(area);
  const schema:FastifySchema={...entry.schema,tags:[label],summary:`${method} · ${label}${parts.slice(2).join('/')?` / ${parts.slice(2).join('/')}`:''}`,description:'由当前已注册接口在启动时自动生成。输入结构来自共用校验器；ID引用、版本冲突、计分和内容规则由服务继续校验。写操作仅限同源请求；此本地服务默认不提供多用户鉴权。',operationId:`${method.toLowerCase()}_${url.replace(/[^a-zA-Z0-9]+/g,'_')}`,response:{200:list?paged(object):object,400:errorSchema,404:errorSchema,409:errorSchema,422:errorSchema,502:errorSchema}};
  const parameters=[...url.matchAll(/:([A-Za-z0-9_]+)/g)].map(match=>match[1]!);
  if(parameters.length)schema.params={type:'object',properties:Object.fromEntries(parameters.map(name=>[name,{type:'string'}])),required:parameters};
  if(list)schema.querystring=toJson(z.object({...paginationFields}));
  if(url==='/api/settings/export')schema.querystring=toJson(configurationExportQuerySchema);
  if(url==='/api/vocabulary'){schema.querystring=toJson(vocabularyQuerySchema);schema.summary='按英语词头查找词义引用';}
  if(url==='/api/documents')schema.querystring=toJson(z.object({...paginationFields,search:z.string().max(1000).optional(),collection:z.enum(['general','personal','all']).optional(),kind:z.string().optional(),domainId:id.optional(),categoryId:id.optional(),tagIds:z.string().optional(),format:z.enum(['markdown','pdf']).optional()}));
  if(url==='/api/question-banks')schema.querystring=toJson(z.object({...paginationFields,search:z.string().max(1000).optional()}));
  if(url==='/api/questions')schema.querystring=toJson(z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(200).default(30),search:z.string().max(1000).optional(),domainId:id.optional(),categoryId:id.optional(),bankId:id.optional(),tagIds:z.string().optional(),tagMode:z.enum(['all','any']).optional(),type:validation.types.optional(),difficulty:z.coerce.number().int().min(1).max(4).optional(),depth:z.coerce.number().int().min(1).max(4).optional(),frequency:z.coerce.number().int().min(0).max(3).optional(),collection:z.enum(['general','personal','all']).optional(),status:z.enum(['published','pending','draft','archived','all']).optional(),favorite:z.enum(['true','false','1','0']).optional(),due:z.enum(['true','false','1','0']).optional(),wrong:z.enum(['true','false','1','0']).optional()}));
  if(['/api/domains','/api/categories','/api/tags'].includes(url))schema.querystring=toJson(z.object({...paginationFields,search:z.string().max(1000).optional(),domainId:id.optional(),parentId:id.optional(),kind:z.string().max(40).optional()}));
  if(url==='/api/reviews')schema.querystring=toJson(z.object({...paginationFields,questionId:id.optional()}));
  if(url==='/api/paper-drafts')schema.querystring=toJson(z.object({context:z.string().min(1).max(160).optional()}));
  if(url==='/api/attempts')schema.querystring=toJson(z.object({...paginationFields,paperId:id.optional(),source:z.enum(['paper','quick']).optional(),status:z.enum(['in_progress','submitted']).optional()}));
  if(url==='/api/ai/runs')schema.querystring=toJson(z.object({...paginationFields,kind:z.enum(['explain','grade','import','review','paper_plan']).optional(),questionId:id.optional(),attemptId:id.optional()}));
  const outputs:Record<string,JsonSchema>={questions:toJson(validation.questionSchema),documents:toJson(validation.documentSchema),'question-banks':toJson(validation.questionBankSchema),domains:toJson(validation.domainSchema),categories:toJson(validation.categorySchema),tags:toJson(validation.tagSchema),papers:paperOutput,attempts:attemptOutput,'paper-drafts':toJson(paperDraftSchema)};
  let success:JsonSchema=outputs[area]||object;
  if(list)success=paged(success);
  if(url==='/api/questions'&&method==='GET')success=(paged(outputs.questions!) as any).anyOf[1];
  if(url==='/api/ai/runs')success=paged(aiRunOutput);
  if(/^\/api\/ai\/runs\/:id$/.test(url)||/^\/api\/ai\/(?:explain|grade|import|review|paper-plan)$/.test(url))success=aiRunOutput;
  if(url==='/api/attempts/:id/ai-review')success=aiRunOutput;
  if(url==='/api/ai/test')success={type:'object',required:['ok','message','model'],properties:{ok:{const:true},message:{type:'string'},model:{type:'string'}}};
  if(url==='/api/ai/runs/:id/paper')success={type:'object',properties:{paper:paperOutput,run:aiRunOutput}};
  if(url==='/api/ai/settings')success=toJson(aiPublicSettingsSchema);
  if(url==='/api/settings')success=method==='GET'?toJson(settingsSchema):{type:'object',properties:{settings:toJson(settingsSchema),retention:{type:'object',properties:{drafts:{type:'integer'},history:{type:'integer'},authoring:{type:'integer'},total:{type:'integer'}}}}};
  if(url==='/api/settings/export')success=toJson(configurationSchema);
  if(url==='/api/settings/import/preview')success=toJson(configurationPreviewSchema);
  if(url==='/api/settings/import')success=toJson(configurationImportResultSchema);
  if(url==='/api/health')success={type:'object',properties:{ok:{const:true}}};
  if(url==='/api/vocabulary')success={type:'object',required:['word','matches'],properties:{word:{type:'string'},matches:{type:'array',items:{type:'object',required:['id','title','status'],properties:{id:{type:'string'},title:{type:'string'},status:{enum:['published','pending','draft','archived']}}}}}};
  if(url==='/api/documents/kinds')success={type:'array',items:{type:'string'}};
  if(url==='/api/study')success={type:'object',properties:{items:{type:'array',items:object},reviews:{type:'array',items:object}}};
  if(url==='/api/exams/active'||url==='/api/exams/sync')success={type:'object',properties:{attempt:{anyOf:[attemptOutput,{type:'null'}]}}};
  if(url==='/api/papers/:id/attempts'||url==='/api/quick-practice'||/^\/api\/attempts\/:id\/(?:sync|submit|review|reveal)$/.test(url))success=attemptOutput;
  if(url==='/api/papers/:id/drafts'||url==='/api/paper-drafts')success={type:'array',items:url.includes('/drafts')?attemptOutput:toJson(paperDraftSchema)};
  if(method==='DELETE')success=object;
  schema.response={...(schema.response as Record<string,unknown>),200:success};
  const body=bodyFor(method,url); if(body)schema.body=body;
  if(method==='POST')schema.response={...(schema.response as Record<string,unknown>),201:success};
  if(streamingAiRoute(method,url)) {
    schema.headers={type:'object',properties:{accept:{type:'string',description:'默认 application/json；Web/桌面传 text/event-stream 可实时接收执行阶段、答案片段和最终结果。'}}};
    schema.description+=' AI 流式模式：Accept: text/event-stream，逐帧 data: JSON + 两次换行；事件为 status、delta、result 或 error，注释心跳应忽略。result 仅在结构校验、版本校验与服务端写入成功后发送；delta 尚未验证，不代表已保存。流已建立时错误通过 error 事件的 statusCode/code/message 返回；建立流之前仍可能返回正常 HTTP 错误。取消或断开连接会中止模型请求，未完成的结果不保存。Android 使用同进程进度通道并等待 JSON 与本地持久化完成，不走 HTTP SSE。';
    schema.response={...(schema.response as Record<string,unknown>),200:{description:'默认 JSON；可通过 Accept 请求执行进度事件流。',content:{'application/json':{schema:success},'text/event-stream':{schema:{type:'string',description:'每个 data 帧的 JSON 遵循 AiProgressEvent；仅 result 是完整验证后的结果。',example:'data: {"type":"status","stage":"preparing","message":"正在准备 AI 任务"}\n\ndata: {"type":"result","result":{}}\n\n'}}}}};
  }
  if(url.startsWith('/api/settings/import')||url==='/api/settings/export') {
    schema.description+=' 独立配置迁移只处理常规偏好与可选 AI 非敏感设置，不含题目、笔记或 API 密钥。先 POST import/preview，再携带 fingerprint 与 confirmed:true 导入；若预览将清理历史/草稿，还须 confirmedRetention:true。配置或作答记录变化后须重新预览。更换服务端点会清除旧密钥，同端点保留本机密钥。';
    if(schema.body) (schema.body as JsonSchema).examples=[url.endsWith('/preview')?{data:configurationExample}:{data:configurationExample,fingerprint:'0'.repeat(64),confirmed:true}];
  }
  if(url.includes('/export')||url.endsWith('/content')){schema.description+=' 文件导出可能按格式返回Markdown、PDF或二进制；JSON导出返回完整封包。';}
  return schema;
}
const configurationExample = { format:'noetic-atlas-configuration', schemaVersion:1, exportedAt:'2026-10-23T00:00:00.000Z', system:Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key])=>key!=='id'&&key!=='updatedAt')) };
function baseDocument(){return {components:{schemas:{QuestionInput:toJson(validation.questionSchema),PaperInput:toJson(validation.paperInputSchema),DocumentInput:toJson(validation.documentSchema),SystemSettings:toJson(settingsSchema),ConfigurationExport:toJson(configurationSchema),ConfigurationPreview:toJson(configurationPreviewSchema),ConfigurationImportResult:toJson(configurationImportResultSchema),PaperDraft:toJson(paperDraftSchema),PaperDraftState:toJson(paperDraftStateSchema),Paper:paperOutput,Attempt:attemptOutput,AiRun:aiRunOutput,AiProgressEvent:aiProgressEvent,AiRecommendationInput:toJson(ai.aiPaperPlanInputSchema),AiRecommendationOutput:toJson(ai.aiPaperPlanOutputSchema),ApiError:errorSchema}},openapi:'3.1.0',info:{title:'认知星图 · Noetic Atlas API',version:'1.0.0',description:'运行时自动生成的本地学习站API。AI密钥仅用于请求服务商，不进入文档、AI记录与分享包。交互文档在本机运行，可直接试用接口。'},servers:[{url:'/'}]};}
function nativeDocument(routes:RouteEntry[]){
  const paths:Record<string,any>={};
  for(const entry of routes){if(!entry.url.startsWith('/api/')||entry.url.startsWith('/api/docs')||entry.url==='/api/openapi.json'||entry.method==='HEAD')continue;const schema=documentationSchema(entry) as any;const path=entry.url.replace(/:([A-Za-z0-9_]+)/g,'{$1}');const operation:any={tags:schema.tags,summary:schema.summary,operationId:schema.operationId,description:schema.description,parameters:[],responses:Object.fromEntries(Object.entries(schema.response).map(([code,value])=>[code,{description:Number(code)<400?'成功':'请求失败',content:(value as any).content||{'application/json':{schema:value}}}]))};for(const [where,shape] of [['path',schema.params],['query',schema.querystring],['header',schema.headers]] as const){for(const [name,value] of Object.entries(shape?.properties||{}))operation.parameters.push({in:where,name,required:where==='path'||shape.required?.includes(name)||false,schema:value});}if(schema.body)operation.requestBody={required:true,content:{'application/json':{schema:schema.body}}};(paths[path]||={})[entry.method.toLowerCase()]=operation;}
  return {...baseDocument(),paths};
}
export async function registerApiDocs(app:FastifyInstance,options:{native?:boolean}={}) {
  const routes:RouteEntry[]=[];
  app.addHook('onRoute', route=>{for(const method of Array.isArray(route.method)?route.method:[route.method])routes.push({method,url:route.url,schema:route.schema});});
  if(options.native){app.get('/api/openapi.json',async()=>nativeDocument(routes));return;}
  const swagger=(await import('@fastify/swagger')).default;const swaggerUi=(await import('@fastify/swagger-ui')).default;
  await app.register(swagger,{openapi:baseDocument(),transform:({schema,url,route})=>({schema:url.startsWith('/api/')&&!url.startsWith('/api/docs')&&url!=='/api/openapi.json'?documentationSchema({method:Array.isArray(route.method)?route.method[0]!:route.method,url,schema}):{...schema,hide:true},url})});
  await app.register(swaggerUi,{routePrefix:'/api/docs',uiConfig:{docExpansion:'none',deepLinking:true},staticCSP:true});
  app.get('/api/openapi.json',async()=>app.swagger());
}
