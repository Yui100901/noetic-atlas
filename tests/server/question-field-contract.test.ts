import test from 'node:test';
import assert from 'node:assert/strict';
import type {Question} from '../../shared/models/types.js';
import {questionSchema} from '../../server/core/validation.js';
import {inspectQuestionQuality} from '../../server/modules/content-quality/rules.js';

const choiceOptions=[{key:'A',text:'整体提交'},{key:'B',text:'整体回滚'},{key:'C',text:'部分提交'}];
const common={title:'事务基础练习',stemMarkdown:'说明或判断事务的整体性。'};
const minimum:Record<string,Record<string,unknown>>={
 short_answer:{...common,type:'short_answer'},
 essay:{...common,type:'essay'},
 true_false:{...common,type:'true_false',correctAnswers:['true']},
 single_choice:{...common,type:'single_choice',options:choiceOptions,correctAnswers:['A']},
 multiple_choice:{...common,type:'multiple_choice',options:choiceOptions,correctAnswers:['A','B']},
 fill_blank:{...common,type:'fill_blank',stemMarkdown:'事务整体提交或____。',blanks:[{id:'operation',label:'操作',answers:['回滚']}]},
 group:{...common,type:'group',parts:[
  {id:'explain',title:'解释整体性',type:'short_answer',stemMarkdown:'为什么不能保留半次转账？'},
  {id:'judge',title:'判断回滚',type:'true_false',stemMarkdown:'同一事务失败后应整体回滚。',correctAnswers:['true']},
 ]},
};

test('all seven question types accept their schema-minimal authoring fields without invented quality requirements',()=>{
 assert.equal(Object.keys(minimum).length,7);
 for(const [type,input]of Object.entries(minimum)){
  const parsed=questionSchema.safeParse(input);assert.ok(parsed.success,`${type}: ${parsed.success?'':parsed.error.message}`);
  assert.deepEqual(inspectQuestionQuality(parsed.data as Question),[],type);
  assert.equal(parsed.data!.answerMarkdown,'',`${type}: separate answer prose is schema-optional`);
  assert.equal(parsed.data!.explanationMarkdown,'',`${type}: separate explanation is schema-optional`);
  assert.deepEqual(parsed.data!.categoryIds,[]);assert.deepEqual(parsed.data!.tagIds,[]);assert.deepEqual(parsed.data!.sourceRefs,[]);
 }
});

test('omitting every field allowed by the authoritative schema never creates a missing-field quality notice',()=>{
 const tested=new Set<string>();
 for(const [type,input]of Object.entries(minimum)){
  const full=questionSchema.parse({...input,id:'CONTRACT-'+type,createdAt:'2026-10-27T00:00:00.000Z',updatedAt:'2026-10-27T00:00:00.000Z'});
  for(const key of Object.keys(questionSchema.shape)){
   if(!questionSchema.shape[key as keyof typeof questionSchema.shape].safeParse(undefined).success)continue;
   const omitted={...full} as Record<string,unknown>;delete omitted[key];
   const parsed=questionSchema.safeParse(omitted);
   // Conditional fields such as choice keys or group parts still fail the
   // complete schema even though their individual property has a default.
   if(!parsed.success)continue;
   tested.add(key);assert.deepEqual(inspectQuestionQuality(parsed.data as Question),[],`${type} without ${key}`);
  }
 }
 for(const field of ['id','answerMarkdown','explanationMarkdown','categoryIds','tagIds','sourceRefs','difficulty','depth','frequency','createdAt','updatedAt','sourceDocument','sourceAnchor','concept','vocabulary'])assert.ok(tested.has(field),field);
});

test('conditional structures fail the same schema and surface a structural quality problem rather than optional metadata warnings',()=>{
 const broken:Array<{type:string;drop?:string;patch?:Record<string,unknown>}>=[
  {type:'true_false',drop:'correctAnswers'},
  {type:'single_choice',drop:'options'},
  {type:'single_choice',drop:'correctAnswers'},
  {type:'multiple_choice',patch:{correctAnswers:['A']}},
  {type:'single_choice',patch:{correctAnswers:['NOT_AN_OPTION']}},
  {type:'fill_blank',drop:'blanks'},
  {type:'fill_blank',patch:{blanks:[{id:'operation',label:'操作',answers:[]}]}},
  {type:'group',drop:'parts'},
  {type:'group',patch:{parts:[{id:'only',title:'唯一小题',type:'short_answer',stemMarkdown:'解释整体性。'}]}},
 ];
 for(const spec of broken){
  const input={...questionSchema.parse(minimum[spec.type]),...spec.patch} as Record<string,unknown>;
  if(spec.drop)delete input[spec.drop];
  assert.equal(questionSchema.safeParse(input).success,false,JSON.stringify(spec));
  const findings=inspectQuestionQuality(input as unknown as Question);
  assert.ok(findings.some(value=>value.rule==='structure'),JSON.stringify(spec));
  assert.ok(!findings.some(value=>value.rule==='missing_source'||value.rule==='missing_explanation'));
 }
});
