import {z} from 'zod';
import {moneySchema} from '../../core/validation.js';
import {gradeResultSchema} from './schema.js';

const fields=['questionId','verdict','score','maxPoints','comment','strengths','improvements'] as const;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const prose=z.string().min(1).max(50_000),list=z.array(z.string().max(4000)).max(50);

/** A model reply is a projection boundary, unlike stored runs and migrations.
 * Discard only auxiliary keys. Identity, judgments and numbers are never fixed,
 * coerced or inferred here; they still pass the strict schema and route checks. */
export function gradeOutputContract(questionIds:string[],warn:(message:string)=>void){
 const modelItem=z.object({questionId:z.enum(questionIds),verdict:z.enum(['correct','partial','incorrect']),score:moneySchema.nullable().describe('有分时为0至原满分的数字，最多两位小数；无分时为null'),maxPoints:moneySchema.nullable().describe('逐字保留输入满分；无分时为null'),comment:prose,strengths:list,improvements:list}).strict();
 const contract=z.toJSONSchema(z.object({items:z.array(modelItem).length(questionIds.length)}).strict(),{io:'input'});
 const validator=z.preprocess(raw=>{
  if(!record(raw))return raw;
  let extra=Object.keys(raw).filter(key=>key!=='items').length,emptyLists=0;
  const items=Array.isArray(raw.items)?raw.items.map(item=>{
   if(!record(item))return item;
   extra+=Object.keys(item).filter(key=>!fields.includes(key as typeof fields[number])).length;
   const projected:Record<string,unknown>={};
   for(const key of fields)if(Object.hasOwn(item,key))projected[key]=item[key];
   for(const key of ['strengths','improvements'])if(projected[key]==null){projected[key]=[];emptyLists++;}
   return projected;
  }):raw.items;
  if(extra)warn('已忽略模型附带的非判题字段，仅保留题号、判定、分值与评价；附加字段不会写入成绩或处理记录。');
  if(emptyLists)warn('模型未提供部分优点或改进列表，已按空列表显示；判定与分值未更改。');
  return Object.hasOwn(raw,'items')?{items}:{};
 },gradeResultSchema);
 return{contract,validator};
}
