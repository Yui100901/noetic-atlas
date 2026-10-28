import {z} from 'zod';
import {blankSchema,id,questionSchema} from '../../core/validation.js';

const ids=z.array(id).max(500).refine(values=>new Set(values).size===values.length,'引用不能重复');
export const aiQuestionEditChangesSchema=z.object({
 title:z.string().trim().min(1).max(300).optional(),
 stemMarkdown:z.string().min(1).max(500_000).optional(),
 answerMarkdown:z.string().max(500_000).optional(),explanationMarkdown:z.string().max(500_000).optional(),
 options:z.array(z.object({key:z.string().min(1).max(20),text:z.string().max(500_000)}).strict()).max(26).optional(),
 correctAnswers:z.array(z.string().max(20)).max(26).optional(),blanks:z.array(blankSchema).max(30).optional(),
 categoryIds:ids.optional(),tagIds:ids.optional(),
}).strict().refine(value=>Object.keys(value).length>0,'每条建议须包含可应用的字段');
export const aiQuestionEditResultSchema=z.object({
 summary:z.string().min(1).max(4000),suggestions:z.array(z.object({
  id, title:z.string().trim().min(1).max(300),reason:z.string().min(1).max(5000),confidence:z.enum(['high','medium','low']),
  partId:id.optional(),changes:aiQuestionEditChangesSchema,
 }).strict()).max(20).refine(values=>new Set(values.map(value=>value.id)).size===values.length,'建议ID不能重复'),
 warnings:z.array(z.string().min(1).max(2000)).max(20).default([]),
}).strict();
export const aiQuestionEditInputSchema=z.object({
 questionId:id,expectedUpdatedAt:z.string().datetime({offset:true}),question:questionSchema.strict(),requirements:z.string().max(5000).default(''),
}).strict();
