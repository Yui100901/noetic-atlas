export interface AiErrorPayload { code?: string; message?: string; details?: unknown }

// Only public contract field names may enter a diagnostic path. Provider-added
// keys, arbitrary messages and received values never become display text.
const publicFields=new Set(['root','field','items','questions','options','key','text','title','type','stemMarkdown','answerMarkdown','explanationMarkdown','correctAnswers','difficulty','depth','frequency','frequencyScope','frequencyBasis','collection','status','categoryIds','tagIds','sourceRefs','label','url','sourceDocument','sourceAnchor','parts','id','blanks','answers','caseSensitive','trim','weight','questionId','verdict','score','maxPoints','comment','strengths','improvements','gradingRequirements','requiresRegrade','issues','suggestedChanges','approvedIds','taxonomySuggestions','domains','categories','tags','followUpsMarkdown','pitfallsMarkdown','reason','description','count','filters','requestedCount','questionIds','ok','message','suggestions','changes','confidence','partId','summary','warnings','attemptId','answer','enabled','baseUrl','model','supportsImages','sendImages','timeoutSeconds','maxTokens','updatedAt','clearKey']);
const ruleMessages:Record<string,string>={invalid_type:'字段类型错误或缺失',invalid_value:'字段值不在允许范围',too_small:'数量、长度或数值低于下限',too_big:'数量、长度或数值超过上限',unrecognized_keys:'存在结构约定外字段',invalid_format:'字段格式不符合约定',custom:'未通过题型或业务规则'};
const advice:Record<string,string>={
 AI_INVALID_OUTPUT:'请按具体字段要求重新请求；持续失败时减少题量或更换模型。完整诊断可在AI处理记录中查看。',
 AI_INVALID_JSON:'请重试当前批次；持续失败时减少题量或更换模型。',
 AI_EMPTY_RESPONSE:'模型未给出可用结果，请重试当前批次或检查模型服务。',
 AI_OUTPUT_TRUNCATED:'请检查系统配置中的最大输出Token与模型限制，或缩小处理范围后重试。',
 AI_TIMEOUT:'请减少当前批次内容，或在系统配置中提高请求超时后重试。',
 AI_GRADE_ITEMS_MISMATCH:'模型必须逐项保留本次题号，请重新评价；也可拆分为单题处理。',
 AI_SCORE_OUT_OF_RANGE:'请重新评价，模型须保留原题满分并在允许范围内给分。',
 AI_GRADE_VERDICT_CONFLICT:'请重新评价，正确、部分正确或错误的判定必须与建议得分一致。',
 AI_GRADE_BLANK_ANSWER:'请重新评价，空白作答必须判为错误，计分时为0分。',
};
const record=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
function shortText(value:unknown,limit:number){if(typeof value!=='string')return'';const text=value.replace(/[\u0000-\u001F\u007F]+/g,' ').replace(/\s+/g,' ').trim();return text.length>limit?text.slice(0,limit-1).replace(/[\uD800-\uDBFF]$/,'')+'…':text;}
function issuePath(value:unknown){
 const parts=Array.isArray(value)?value.slice(0,8):typeof value==='string'?value.slice(0,200).replace(/\[(\d+)\]/g,'.$1').split('.').slice(0,8):[];
 const path=parts.map(part=>typeof part==='number'&&Number.isInteger(part)&&part>=0&&part<=999999?String(part):typeof part==='string'&&/^\d{1,6}$/.test(part)?part:typeof part==='string'&&publicFields.has(part)?part:'field').join('.');
 return shortText(!path||path==='root'?'输出根节点':path,100);
}

/** JSON HTTP errors, SSE error events and native responses use one bounded
 * presentation. Preserve original metadata for callers and audit navigation. */
export function aiResponseErrorInfo(error:AiErrorPayload|undefined,status=500){
 const code=error?.code||'HTTP_ERROR',details=error?.details,failure=record(record(details)?.failure);
 const source=failure&&Array.isArray(failure.validationIssues)?failure.validationIssues:Array.isArray(details)?details:[];
 const issues=source.slice(0,3).map(value=>{const issue=record(value);if(!issue)return'';const rule=typeof issue.rule==='string'?issue.rule:typeof issue.code==='string'?issue.code:'';return `${issuePath(issue.path)}：${Object.hasOwn(ruleMessages,rule)?ruleMessages[rule]:'字段未通过结构校验'}`;}).filter(Boolean);
 const recommendation=failure&&failure.code===code?(Object.hasOwn(advice,code)?advice[code]:'请核对本次资料与任务要求后重试，完整诊断可在AI处理记录中查看。'):'';
 const message=[shortText(error?.message,800)||`请求失败（${status}）`,issues.length?`校验问题：${issues.join('；')}${source.length>3?'；更多问题请查看AI处理记录':''}`:'',recommendation?`建议：${recommendation}`:''].filter(Boolean).join('。');
 return{message,code,status,details};
}
