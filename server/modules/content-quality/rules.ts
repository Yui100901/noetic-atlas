import { createHash } from 'node:crypto';
import type { Question, QuestionPart } from '../../../shared/models/types.js';
import type { QualityRule, QualitySeverity } from '../../../shared/models/content-quality.js';
import { conceptPromptIsSafe } from '../../../shared/questions/concept.js';
import { findBlankMarkers } from '../../../shared/questions/blank-markers.js';
import { questionSchema } from '../../core/validation.js';

export interface QualityFinding {rule:QualityRule;severity:QualitySeverity;partId?:string;message:string;evidence:string;suggestion:string}
// JSON object key order is irrelevant; array order and every source character
// remain significant, including code whitespace, case, units and negation.
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,canonical(value)])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))??'undefined').digest('hex');
const string=(value:unknown)=>typeof value==='string'?value:'';
const prose=(value:unknown)=>string(value).replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)|`+[^`\n]*`+/g,' ');
const record=(value:any):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const array=(value:any):any[]=>Array.isArray(value)?value:[];
const leaf=(raw:any):unknown=>{const value=record(raw);return{type:value.type,stemMarkdown:value.stemMarkdown,options:value.options,blanks:array(value.blanks).map((raw:any)=>{const blank=record(raw);return{id:blank.id,label:blank.label,caseSensitive:blank.caseSensitive,trim:blank.trim};}),...(Array.isArray(value.parts)?{parts:value.parts.map(leaf)}:{})};};
const answers=(raw:any):unknown=>{const value=record(raw);return{correctAnswers:value.correctAnswers,answerMarkdown:value.answerMarkdown,blanks:array(value.blanks).map((raw:any)=>{const blank=record(raw);return{id:blank.id,answers:blank.answers,caseSensitive:blank.caseSensitive,trim:blank.trim};}),...(Array.isArray(value.parts)?{parts:value.parts.map(answers)}:{})};};
export function qualityContentFingerprint(value:Question|Record<string,any>) {
  // Publication is a separate workflow; approving a question must not erase
  // a still-applicable finding or falsely change its input version.
  const {study:_study,partStudies:_parts,feedbackSummary:_feedback,createdAt:_created,updatedAt:_updated,status:_status,...authoring}=record(value);
  return digest(authoring);
}
export function qualitySignatures(value:Question) {
  const prompt=leaf(value),answer=answers(value);
  const grading=['single_choice','multiple_choice','true_false'].includes(value.type)?array(value.correctAnswers).slice().sort():value.type==='fill_blank'?array(value.blanks).map(raw=>{const blank=record(raw);return{id:blank.id,answers:array(blank.answers).map(raw=>typeof raw==='string'?(blank.caseSensitive===false?raw.toLocaleLowerCase('en'):raw):raw).sort(),caseSensitive:blank.caseSensitive,trim:blank.trim};}):answer;
  return {promptHash:digest(prompt),answerHash:digest(grading),fullHash:digest({prompt,answer,explanationMarkdown:value.explanationMarkdown,parts:array(value.parts).map(part=>record(part).explanationMarkdown),concept:value.concept,vocabulary:value.vocabulary})};
}
export function inspectQuestionQuality(question:Question):QualityFinding[] {
  const findings:QualityFinding[]=[];
  const add=(rule:QualityRule,severity:QualitySeverity,message:string,evidence:string,suggestion:string,partId?:string)=>findings.push({rule,severity,message,evidence:evidence.slice(0,4000),suggestion,...(partId?{partId}:{})});
  const parsed=questionSchema.safeParse(question);
  if(!parsed.success)add('structure','error','当前题目不符合结构或答案引用规则',parsed.error.issues.slice(0,10).map(issue=>`${issue.path.join('.')||'题目'}：${issue.message}`).join('\n'),'在题目编辑器核对对应字段；确认修改后重新扫描。');
  const inspect=(value:Question|QuestionPart,partId?:string)=>{
    if(!value||typeof value!=='object')return;
    const stem=string(value.stemMarkdown),answer=string(value.answerMarkdown),explanation=string(value.explanationMarkdown);
    if(!stem.trim())add('empty_stem','error','题干只有空白或缺失','题干未包含可阅读内容。','补充作答所需的条件和问题。',partId);
    // An explanation may already live in answerMarkdown. A separate field is
    // optional; its absence cannot establish inadequate teaching content.
    const options=Array.isArray(value.options)?value.options:[];
    const seen=new Map<string,string>();
    for(const option of options){if(!option||typeof option!=='object')continue;const text=string(option.text).replace(/\r\n/g,'\n');if(!text.trim())continue;const previous=seen.get(text);if(previous)add('duplicate_options','warning','两个选项具有完全相同的正文',`选项 ${previous} 与 ${option.key}：${text.slice(0,1500)}`,'核对是否误填了选项；不自动替换或重排答案。',partId);else seen.set(text,option.key);}
    const visible=prose(stem);
    if(value.type==='fill_blank'){
      const placeholders=findBlankMarkers(stem);
      if(placeholders.length)add('template_placeholder','warning','填空题仍显示原始模板占位符',placeholders.slice(0,10).map(({marker,offset})=>`位置 ${offset}：${stem.slice(Math.max(0,offset-50),offset+marker.length+50)}`).join('\n'),'把用于作答的占位符显示为横线；保留代码示例里的原始语法。',partId);
    }
    const redundant=visible.match(/(?:^|\n)\s*(?:数据许可|版权声明|学习说明|通用学习提示)\s*[:：][^\n]{0,300}|WordNet\s*框架\s*\d+|义项\s*\d{8}-[nvars]|未列通用缩写[，,]?\s*不自行创造/gi);
    if(redundant?.length)add('redundant_stem','notice','题干可能混入数据说明或模板元数据',redundant.join('\n'),'将来源和通用说明放入参考资料或集中说明；先核对它是否本来就是题目考查内容。',partId);
    if(['single_choice','multiple_choice'].includes(value.type)){
      const conclusion=prose(explanation).match(/(?:^|\n)\s*(?:正确答案(?:为|是|[:：])|故选|应选)\s*([A-Z](?:\s*[、,，和及]\s*[A-Z])*)(?:[。；;\s]|$)/);
      if(conclusion){const named:string[]=(conclusion[1]||conclusion[2]).match(/[A-Z]/g)||[];const correct:string[]=Array.isArray(value.correctAnswers)?value.correctAnswers:[];if(named.some(key=>!correct.includes(key))||correct.some(key=>!named.includes(key)))add('answer_explanation_conflict','warning','解析中的显式答案结论与保存答案不同',`保存答案：${correct.join('、')}；解析片段：${conclusion[0]}`,'核对题干条件、选项及版本后确认；规则只比较明确的选项结论，不证明哪一方正确。',partId);}
    }
    if(value.type==='true_false'){
      const exact=answer.trim().replace(/[。.!！\s]+$/,'').toLowerCase(),truth=['对','正确','true','是'].includes(exact)?'true':['错','错误','false','否'].includes(exact)?'false':undefined;
      if(truth&&value.correctAnswers?.[0]!==truth)add('answer_explanation_conflict','warning','判断题的答案文字与判定值不同',`答案文字：${answer}；保存判定：${value.correctAnswers?.[0]||'缺失'}`,'核查后统一判定与展示文字；不自动重判历史回答。',partId);
    }
  };
  inspect(question);
  if(Array.isArray(question.parts))for(const part of question.parts)inspect(part,part?.id);
  // References are optional authoring metadata. An empty list is not a quality
  // problem; supplied references still undergo normal structure/link checks.
  for(const ref of array(question.sourceRefs)){if(typeof ref?.url!=='string')continue;try{const url=new URL(ref.url);if(url.hostname==='example.com'||url.hostname==='example.org'||url.hostname.endsWith('.invalid'))add('reference_placeholder','warning','参考来源仍为示例或无效占位域名',ref.url,'替换为实际参考资料；本规则没有联网检查其它链接是否可达。');}catch{/* Internal links are valid sources and schema handles invalid URLs. */}}
  if(question.concept&&typeof question.concept.meaningPrompt==='string'&&typeof question.concept.term==='string'&&Array.isArray(question.concept.acceptedAnswers)&&question.concept.acceptedAnswers.every(answer=>typeof answer==='string')&&!conceptPromptIsSafe(question.concept))add('concept_prompt_leak','error','概念反向提示可能暴露主词或包含不支持的格式',string(question.concept.meaningPrompt),'重写独立短定义，去掉主词及已接受别称；保留完整解析用于交卷后核对。');
  return findings;
}
