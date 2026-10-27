import { z } from 'zod';
import { QUALITY_RULE_LABELS } from '../../../shared/models/content-quality.js';
import { id, types } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';

const stamp=z.string().datetime({offset:true}), digest=z.string().regex(/^[a-f0-9]{64}$/);
const rules=Object.keys(QUALITY_RULE_LABELS) as [keyof typeof QUALITY_RULE_LABELS,...Array<keyof typeof QUALITY_RULE_LABELS>];
export const qualityRuleSchema=z.enum(rules);
export const qualityIssueStatusSchema=z.enum(['open','confirmed','resolved','dismissed','stale']);
export const qualitySeveritySchema=z.enum(['error','warning','notice']);
const statusCounts=z.object({open:z.number().int().nonnegative(),confirmed:z.number().int().nonnegative(),resolved:z.number().int().nonnegative(),dismissed:z.number().int().nonnegative(),stale:z.number().int().nonnegative()}).strict();
export const qualityFiltersSchema=z.object({questionId:id.optional(),domainId:id.optional(),categoryId:id.optional(),tagIds:z.array(id).max(50).default([]),type:types.optional(),status:z.enum(['all','published','pending','draft','archived']).default('all')}).strict();
const counts=z.object({error:z.number().int().nonnegative(),warning:z.number().int().nonnegative(),notice:z.number().int().nonnegative()}).strict();
export const qualityScanSchema=z.object({
  id,ruleVersion:z.string().min(1).max(100),status:z.enum(['ready','completed','cancelled','failed']),filters:qualityFiltersSchema,
  createdAt:stamp,updatedAt:stamp,finishedAt:stamp.nullable(),cursor:id.nullable(),upperId:id.nullable(),plannedTotal:z.number().int().nonnegative(),
  processed:z.number().int().nonnegative(),findings:z.number().int().nonnegative(),newIssues:z.number().int().nonnegative(),changedSources:z.number().int().nonnegative(),
  severityCounts:counts,ruleCounts:z.partialRecord(qualityRuleSchema,z.number().int().nonnegative()),lastFailure:z.object({code:z.string().max(100),message:z.string().max(1000)}).strict().optional(),
}).strict();
export const qualityIssueSchema=z.object({
  id,questionId:id,partId:id.optional(),questionTitle:z.string().min(1).max(300),domainIds:z.array(id).max(50),
  contentFingerprint:digest,ruleVersion:z.string().min(1).max(100),rule:qualityRuleSchema,severity:qualitySeveritySchema,status:qualityIssueStatusSchema,
  message:z.string().min(1).max(2000),evidence:z.string().max(4000),suggestion:z.string().max(2000),
  relatedQuestions:z.array(z.object({questionId:id,title:z.string().min(1).max(300),contentFingerprint:digest}).strict()).max(5),
  createdAt:stamp,updatedAt:stamp,lastDetectedAt:stamp,scanId:id.optional(),origin:z.enum(['scan','feedback']).optional(),feedbackIds:z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length,'关联反馈不能重复').optional(),note:z.string().max(5000),
}).strict();
export const qualityFingerprintSchema=z.object({id,contentFingerprint:digest,promptHash:digest,fullHash:digest,answerHash:digest,sourceStamp:z.string().max(100),title:z.string().min(1).max(300),type:types,domainIds:z.array(id).max(50),indexedAt:stamp,ruleVersion:z.string().max(100)}).strict();
export const qualityScanCreateSchema=z.object({filters:qualityFiltersSchema.default({tagIds:[],status:'all'})}).strict();
export const qualityScanProcessSchema=z.object({batchSize:z.number().int().min(1).max(200).default(100)}).strict();
export const qualityIssueQuerySchema=z.object({
  page:paginationFields.page.default(1),pageSize:paginationFields.pageSize.default(20),status:z.enum(['all','active','open','confirmed','resolved','dismissed','stale']).default('active'),
  origin:z.enum(['all','scan','feedback']).default('all'),feedbackId:id.optional(),severity:qualitySeveritySchema.optional(),rule:qualityRuleSchema.optional(),domainId:id.optional(),questionId:id.optional(),scanId:id.optional(),search:z.string().trim().max(200).default(''),
}).strict();
export const qualityQuestionGroupSchema=z.object({
  questionId:id,questionTitle:z.string().min(1).max(300),sourceAvailable:z.boolean(),
  issueCount:z.number().int().positive(),matchedIssueCount:z.number().int().positive(),activeIssueCount:z.number().int().nonnegative(),
  counts:statusCounts,
  origins:z.array(z.enum(['scan','feedback'])).min(1).max(2),severity:qualitySeveritySchema,updatedAt:stamp,
}).strict();
export const qualityOverviewSchema=z.object({
  counts:statusCounts,severity:counts,totalIssues:z.number().int().nonnegative(),totalQuestions:z.number().int().nonnegative(),activeQuestions:z.number().int().nonnegative(),
  latestScan:qualityScanSchema.nullable(),ruleVersion:z.string().min(1).max(100),
  coverage:z.object({deterministic:z.literal(true),semanticVerification:z.literal('not_performed'),sourceReachability:z.literal('not_checked'),message:z.string()}).strict(),
}).strict();
export const qualityScanQuerySchema=z.object({page:paginationFields.page.default(1),pageSize:paginationFields.pageSize.default(20)}).strict();
export const qualityResolveSchema=z.object({status:z.enum(['open','confirmed','resolved','dismissed']),note:z.string().trim().max(5000).default(''),expectedUpdatedAt:stamp}).strict()
  .refine(input=>input.status==='open'||!!input.note,'确认、解决或忽略时请填写依据或处理说明');
export const qualityBulkResolveSchema=z.object({ids:z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length,'问题ID不能重复'),status:z.enum(['open','confirmed','resolved','dismissed']),note:z.string().trim().max(5000).default(''),expectedUpdatedAt:z.record(id,stamp)}).strict()
  .refine(input=>input.status==='open'||!!input.note,'确认、解决或忽略时请填写依据或处理说明')
  .refine(input=>Object.keys(input.expectedUpdatedAt).length===input.ids.length&&input.ids.every(id=>!!input.expectedUpdatedAt[id]),'每条问题需提供且仅提供对应版本');

export const qualityReviewContextSchema=z.object({expectedUpdatedAt:stamp}).strict();
export const qualityReviewContextsSchema=z.object({ids:z.array(id).min(1).max(20).refine(values=>new Set(values).size===values.length,'问题不能重复'),expectedUpdatedAt:z.record(id,stamp)}).strict().refine(value=>Object.keys(value.expectedUpdatedAt).length===value.ids.length&&value.ids.every(id=>!!value.expectedUpdatedAt[id]),'每条问题必须提供且仅提供对应的updatedAt版本');
