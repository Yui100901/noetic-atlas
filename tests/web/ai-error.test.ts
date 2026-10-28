import test from 'node:test';
import assert from 'node:assert/strict';
import {aiResponseErrorInfo} from '../../web/features/ai/ai-error.js';

test('AI audit errors display bounded validation paths and actionable advice while retaining original metadata',()=>{
 const details={auditId:'ai-test',failure:{code:'AI_INVALID_OUTPUT',recommendation:'PRIVATE_PROVIDER_TEXT',validationIssues:[{path:'items.0.verdict',rule:'invalid_value',message:'PRIVATE_PROVIDER_VALUE'},{path:'items.0',rule:'unrecognized_keys',message:'PRIVATE_PROVIDER_KEY'}]},diagnostics:{httpStatus:200}};
 const info=aiResponseErrorInfo({code:'AI_INVALID_OUTPUT',message:'模型结果不符合结构约定，未修改题库或成绩',details},502);
 assert.equal(info.code,'AI_INVALID_OUTPUT');assert.equal(info.status,502);assert.equal(info.details,details);
 assert.match(info.message,/items\.0\.verdict：字段值不在允许范围/);assert.match(info.message,/items\.0：存在结构约定外字段/);assert.match(info.message,/建议：.*重新请求/);assert.match(info.message,/AI处理记录/);assert.doesNotMatch(info.message,/PRIVATE_PROVIDER/);
});

test('AI validation rendering never echoes unknown keys, received values, bodies or arbitrary issue messages',()=>{
 const info=aiResponseErrorInfo({code:'AI_INVALID_OUTPUT',message:'结构无效',details:{failure:{code:'AI_INVALID_OUTPUT',validationIssues:[{path:'items.0.PRIVATE_FIELD',rule:'custom',message:'PRIVATE_BODY',received:'PRIVATE_VALUE'},{path:['items',1,'PRIVATE_FIELD'],rule:'PRIVATE_RULE',message:'PRIVATE_SECRET'}]},body:'PRIVATE_ENVELOPE'}},502);
 assert.match(info.message,/items\.0\.field：未通过题型或业务规则/);assert.match(info.message,/items\.1\.field：字段未通过结构校验/);assert.doesNotMatch(info.message,/PRIVATE_/);
});

test('AI errors retain legacy validation arrays but limit displayed issues and all message lengths',()=>{
 const details=Array.from({length:20},(_,index)=>({path:'items.'+index+'.score',rule:'invalid_type',message:'x'.repeat(5000)}));
 const info=aiResponseErrorInfo({code:'VALIDATION_ERROR',message:'错误'.repeat(2000),details},400);
 assert.equal(info.details,details);assert.equal(info.status,400);assert.equal(info.code,'VALIDATION_ERROR');
 assert.equal((info.message.match(/字段类型错误或缺失/g)||[]).length,3);assert.match(info.message,/更多问题请查看AI处理记录/);assert.ok(info.message.length<1400);assert.doesNotMatch(info.message,/items\.3\./);
 const legacy=aiResponseErrorInfo({message:'输入数据不符合约定',details:[{path:'maxTokens',message:'Unrecognized key PRIVATE_FIELD'}]},400);
 assert.match(legacy.message,/maxTokens：字段未通过结构校验/);assert.doesNotMatch(legacy.message,/PRIVATE_FIELD/);
});

test('AI error formatting tolerates missing or malformed diagnostics and does not trust unrelated advice',()=>{
 assert.deepEqual(aiResponseErrorInfo(undefined,503),{message:'请求失败（503）',code:'HTTP_ERROR',status:503,details:undefined});
 for(const details of [null,'PRIVATE_BODY',[],{failure:null},{failure:{code:'OTHER',recommendation:'PRIVATE_ADVICE',validationIssues:[null,7]}}]){
  const info=aiResponseErrorInfo({code:'AI_INVALID_OUTPUT',message:'失败',details},502);assert.equal(info.details,details);assert.doesNotMatch(info.message,/PRIVATE_/);assert.ok(info.message.length<1400);
 }
 const info=aiResponseErrorInfo({code:'AI_OUTPUT_TRUNCATED',message:'输出被截断',details:{failure:{code:'AI_OUTPUT_TRUNCATED',recommendation:'PRIVATE_ADVICE'}}},502);assert.match(info.message,/最大输出Token/);assert.doesNotMatch(info.message,/PRIVATE_ADVICE/);
 const inherited=aiResponseErrorInfo({code:'constructor',message:'失败',details:{failure:{code:'constructor',validationIssues:[{path:'items.0',rule:'toString'}]}}},502);assert.match(inherited.message,/字段未通过结构校验/);assert.doesNotMatch(inherited.message,/native code|function Object|\[object Object\]/);
});
