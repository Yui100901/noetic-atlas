import { z } from 'zod';
import { AI_WORKSPACE_DRAFT_KINDS, AI_WORKSPACE_DRAFT_MAX_BYTES, type AiWorkspaceDraftKind } from '../../../shared/ai/workspace-drafts.js';
import { id, types } from '../../core/validation.js';
import { aiImportResultOutputSchema, aiPaperPlanOutputSchema } from './schema.js';
import { aiDiagnosticsSchema } from './audit-schema.js';

const stamp=z.string().datetime({offset:true}),strings=z.array(z.string().max(10000)).max(10000),indexes=z.array(z.number().int().min(0).max(100000)).max(10000);
const text=z.string(),numeric=z.number().finite().nullable();
// This is a completed public result snapshot, never provider settings or the
// private run context. Authority to import/create remains in the original run.
const runBase={id,createdAt:stamp,model:z.string().max(200),warnings:strings,status:z.literal('completed'),questionIds:strings,attemptId:id.optional(),appliedAt:stamp.optional(),jobId:id.optional(),batchId:id.optional(),feedbackId:id.optional(),diagnostics:aiDiagnosticsSchema.optional(),appliedScores:strings.optional(),appendedNotes:strings.optional(),importedQuestionIds:strings.optional(),correctedQuestionIds:strings.optional(),createdPaperId:id.optional()};
const planResult=aiPaperPlanOutputSchema.extend({requestedCount:z.number().int().positive(),candidateCount:z.number().int().nonnegative(),candidates:z.array(z.object({id,title:z.string(),type:types}).strict()).max(10000),retrieval:z.object({availableCount:z.number().int().nonnegative(),matchedCount:z.number().int().nonnegative(),reviewedCount:z.number().int().nonnegative(),batches:z.number().int().nonnegative(),interpreted:z.boolean(),summary:z.string()}).strict().optional()});
const filters=z.object({domainId:text,categoryId:text,tagIds:strings,tagMode:z.enum(['all','any']),types:strings,difficultyMin:numeric,difficultyMax:numeric,frequencyMin:numeric,collection:z.enum(['all','general','personal']),paperId:text,search:text,depthMin:numeric,depthMax:numeric,frequencyMax:numeric}).partial().strict();
const section=z.object({text,sourceName:text,label:text,pageStart:numeric.optional(),pageEnd:numeric.optional()}).strict();
const local=z.object({sections:z.array(section).max(2000),sourceName:text,characters:numeric,bytes:numeric,files:numeric,pages:numeric,warnings:strings}).strict();
const states:Record<AiWorkspaceDraftKind,z.ZodType>={
 paper:z.object({prompt:text,count:text,manualCount:z.boolean(),filters,run:z.object({...runBase,kind:z.literal('paper_plan'),result:planResult}).strict().nullable(),ids:strings,title:text,description:text,organization:z.enum(['domain','other']),domainId:text,enabled:z.boolean(),points:z.record(z.string(),numeric),manualIds:text,open:strings}).partial().strict(),
 import:z.object({text,sourceName:text,message:text,count:numeric,categoryIds:strings,tagIds:strings,mode:z.enum(['extract','generate']),requirements:text,sourceUrl:text,questionTypes:strings,difficulty:text,run:z.object({...runBase,kind:z.literal('import'),result:aiImportResultOutputSchema}).strict().nullable(),json:text,selected:indexes}).partial().strict(),
 documents:z.object({local:local.nullable(),sourceName:text,sourceUrl:text,requirements:text,first:text,last:text,perBlock:numeric,maximum:numeric,mode:z.enum(['extract','generate']),types:strings,difficulty:text,categoryIds:strings,tagIds:strings,jobId:id.nullable(),page:numeric,pageSize:numeric}).partial().strict(),
 'document-job':z.object({selected:strings,search:text,onlyFailed:z.boolean(),expanded:text,edits:z.record(z.string(),z.object({json:text,selected:indexes,baseQuestions:text.optional(),baseRunId:id.nullable().optional()}).strict()),page:numeric,pageSize:numeric}).partial().strict(),
};

/** Check JSON bounds before descending through nested schemas. Temporary null
 * numbers, incomplete JSON editor text and unavailable taxonomy are legitimate
 * draft contents; credentials and transient runtime state are not fields here. */
function boundedJson(value:unknown):boolean{
 const pending:Array<{value:unknown;depth:number}>=[{value,depth:0}];let nodes=0;
 while(pending.length){const item=pending.pop()!;if(++nodes>750000||item.depth>24)return false;const child=item.value;
  if(child===null||typeof child==='string'||typeof child==='boolean')continue;
  if(typeof child==='number'){if(!Number.isFinite(child))return false;continue;}
  if(!child||typeof child!=='object'||Object.getPrototypeOf(child)!==Object.prototype&&!Array.isArray(child))return false;
  for(const [key,next] of Object.entries(child)){if(['__proto__','prototype','constructor'].includes(key))return false;pending.push({value:next,depth:item.depth+1});}
 }
 return new TextEncoder().encode(JSON.stringify(value)).byteLength<=AI_WORKSPACE_DRAFT_MAX_BYTES;
}
const state=z.record(z.string(),z.unknown()).refine(boundedJson,'草稿必须为有限JSON，且不能超过24MiB或嵌套深度上限');
function checkState(value:{kind:AiWorkspaceDraftKind;contextId:string|null;state:Record<string,unknown>},context:z.RefinementCtx){
 if((value.kind==='document-job')!==Boolean(value.contextId))context.addIssue({code:'custom',path:['contextId'],message:'仅教材任务草稿必须指定任务上下文'});
 if(!boundedJson(value.state))return;
 const parsed=states[value.kind].safeParse(value.state);if(!parsed.success)for(const issue of parsed.error.issues)context.addIssue({...issue,path:['state',...issue.path]});
}
export const aiWorkspaceDraftQuerySchema=z.object({kind:z.enum(AI_WORKSPACE_DRAFT_KINDS),contextId:id.nullable().optional().transform(value=>value||null)}).strict().superRefine((value,context)=>{if((value.kind==='document-job')!==Boolean(value.contextId))context.addIssue({code:'custom',path:['contextId'],message:'教材任务需要上下文，其他工作台不接受任务上下文'});});
export const aiWorkspaceDraftCreateSchema=z.object({kind:z.enum(AI_WORKSPACE_DRAFT_KINDS),contextId:id.nullable().default(null),state}).strict().superRefine(checkState);
export const aiWorkspaceDraftSchema=z.object({id,kind:z.enum(AI_WORKSPACE_DRAFT_KINDS),contextId:id.nullable(),state,createdAt:stamp,updatedAt:stamp}).strict().superRefine(checkState);
export const aiWorkspaceDraftUpdateSchema=z.object({expectedUpdatedAt:stamp,state}).strict();
export const aiWorkspaceDraftDeleteSchema=z.object({expectedUpdatedAt:stamp}).strict();
