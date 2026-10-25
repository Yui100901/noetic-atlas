import {z} from 'zod';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/,'日期须为YYYY-MM-DD').refine(value=>{const instant=new Date(value+'T00:00:00Z');return Number.isFinite(instant.getTime())&&instant.toISOString().slice(0,10)===value;},'日期无效');
export const analyticsTimeZone=z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'时区无效');
export const analyticsQuerySchema=z.object({from:date.optional(),to:date.optional(),timeZone:analyticsTimeZone.optional()}).strict();
export const weeklyQuerySchema=z.object({week:date.optional(),timeZone:analyticsTimeZone.optional()}).strict();
