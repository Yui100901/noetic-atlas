import test from 'node:test';
import assert from 'node:assert/strict';
import type {QuestionInput,QuestionPart} from '../../shared/models/types.js';
import type {AiQuestionEditChanges,AiQuestionEditSuggestion} from '../../shared/ai/question-edit.js';
import {applyAiQuestionEditSuggestion,undoAiQuestionEditSuggestion,type AiQuestionEditReceipt} from '../../web/features/questions/ai-question-edit-policy.js';

const question=(patch:Partial<QuestionInput>={}):QuestionInput=>({id:'Q1',title:'说明原子性',type:'short_answer',stemMarkdown:'说明事务原子性。',answerMarkdown:'全部提交或回滚。',explanationMarkdown:'按整体处理。',options:[],correctAnswers:[],difficulty:1,depth:1,frequency:0,frequencyScope:'',frequencyBasis:'经验判断',collection:'general',status:'pending',categoryIds:['db'],tagIds:['transaction'],sourceRefs:[],sourceDocument:null,sourceAnchor:null,...patch});
const suggestion=(id:string,changes:AiQuestionEditChanges,partId?:string):AiQuestionEditSuggestion=>({id,title:'核查后修改',reason:'对齐题意与答案。',confidence:'medium',changes,...(partId?{partId}:{})});
function applied(current:QuestionInput,baseline:QuestionInput,s:AiQuestionEditSuggestion){const result=applyAiQuestionEditSuggestion(current,baseline,s);assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw Error(result.message);return result;}
function undone(current:QuestionInput,receipt:AiQuestionEditReceipt){const result=undoAiQuestionEditSuggestion(current,receipt);assert.equal(result.ok,true,JSON.stringify(result));if(!result.ok)throw Error(result.message);return result.value;}
const part=(id:string,patch:Partial<QuestionPart>={}):QuestionPart=>({id,title:'小题'+id,type:'short_answer',stemMarkdown:'说明概念'+id,answerMarkdown:'答案'+id,explanationMarkdown:'',options:[],correctAnswers:[],...patch});

test('independent suggestions can be applied and individually undone without replacing manual or sibling edits',()=>{
 const base=question(),original=structuredClone(base),current={...base,frequencyScope:'用户刚补充的适用范围'};
 const first=applied(current,base,suggestion('stem',{stemMarkdown:'结合回滚说明事务的整体性。'}));
 const second=applied(first.value,base,suggestion('taxonomy',{categoryIds:['db','engineering'],tagIds:['transaction','atomicity']}));
 const undoFirst=undone({...second.value,explanationMarkdown:'用户补充的解释。'},first.receipt);
 assert.equal(undoFirst.stemMarkdown,base.stemMarkdown);assert.deepEqual(undoFirst.categoryIds,['db','engineering']);assert.equal(undoFirst.explanationMarkdown,'用户补充的解释。');assert.equal(undoFirst.frequencyScope,'用户刚补充的适用范围');
 const undoSecond=undone(undoFirst,second.receipt);assert.deepEqual(undoSecond.tagIds,base.tagIds);assert.deepEqual(undoSecond.categoryIds,base.categoryIds);assert.equal(undoSecond.explanationMarkdown,'用户补充的解释。');assert.deepEqual(base,original);
});

test('analysis-time field conflicts reject the entire suggestion, including its other atomic changes',()=>{
 const base=question(),current={...base,stemMarkdown:'用户已经改过题干。'};
 const result=applyAiQuestionEditSuggestion(current,base,suggestion('coupled',{stemMarkdown:'AI题干。',answerMarkdown:'AI答案。'}));
 assert.equal(result.ok,false);if(!result.ok){assert.equal(result.code,'field_conflict');assert.deepEqual(result.fields,['stemMarkdown']);}
 assert.equal(current.answerMarkdown,base.answerMarkdown);assert.equal(current.stemMarkdown,'用户已经改过题干。');
 const first=applied(base,base,suggestion('first',{answerMarkdown:'第一条的答案。'}));
 const overlapping=applyAiQuestionEditSuggestion(first.value,base,suggestion('second',{answerMarkdown:'第二条的答案。'}));assert.equal(overlapping.ok,false);assert.equal(first.value.answerMarkdown,'第一条的答案。');
});

test('undo refuses a changed field rather than overwriting later manual content or another suggestion',()=>{
 const base=question(),first=applied(base,base,suggestion('answer',{answerMarkdown:'AI修订答案。',explanationMarkdown:'AI修订说明。'}));
 const manuallyEdited={...first.value,explanationMarkdown:'保存以后用户又手动补充的新说明。'};
 const refused=undoAiQuestionEditSuggestion(manuallyEdited,first.receipt);assert.equal(refused.ok,false);if(!refused.ok)assert.deepEqual(refused.fields,['explanationMarkdown']);assert.equal(manuallyEdited.answerMarkdown,'AI修订答案。');
 // A later analysis may use the first applied value as its own baseline.
 const later=applied(first.value,first.value,suggestion('later',{answerMarkdown:'后一轮分析的答案。'}));
 assert.equal(undoAiQuestionEditSuggestion(later.value,first.receipt).ok,false);
 assert.equal(undone(first.value,first.receipt).answerMarkdown,base.answerMarkdown);
});

test('choice edits keep options and grading keys atomic and guard later cross-field dependencies when undoing',()=>{
 const base=question({type:'single_choice',options:[{key:'A',text:'全部提交'},{key:'B',text:'部分提交'}],correctAnswers:['B']});
 const change=suggestion('choice',{options:[{key:'A',text:'整体提交或回滚'},{key:'C',text:'允许部分提交'}],correctAnswers:['A']});
 const first=applied(base,base,change);assert.deepEqual(first.value.correctAnswers,['A']);assert.equal(first.value.options[1].key,'C');assert.deepEqual(undone(first.value,first.receipt),base);
 const canonicalized={...first.value,options:first.value.options.map(option=>({text:option.text,key:option.key}))};assert.deepEqual(undone(canonicalized,first.receipt),base,'a save that normalizes JSON member order does not create a false field conflict');
 const laterKeys={...first.value,correctAnswers:['C']};assert.equal(undoAiQuestionEditSuggestion(laterKeys,first.receipt).ok,false);
 // A stand-alone options proposal must not invalidate a manually changed key.
 const optionsOnly=suggestion('options',{options:[{key:'A',text:'整体提交'},{key:'B',text:'部分完成'}]});
 assert.equal(applyAiQuestionEditSuggestion({...base,correctAnswers:['A']},base,optionsOnly).ok,false);
 const optionsApplied=applied(base,base,optionsOnly);assert.equal(undoAiQuestionEditSuggestion({...optionsApplied.value,correctAnswers:['A']},optionsApplied.receipt).ok,false);
});

test('existing group leaves are matched by identity across reordering and remain independent from root taxonomy',()=>{
 const base=question({type:'group',stemMarkdown:'公共材料。',parts:[part('one'),part('two')]}),first=applied(base,base,suggestion('leaf',{title:'核对第一小题',answerMarkdown:'修订第一小题答案。'},'one'));
 const reordered={...first.value,parts:[{...first.value.parts![1],stemMarkdown:'手动改了第二小题。'},first.value.parts![0]]};
 const taxonomy=applied(reordered,base,suggestion('tags',{tagIds:['new-tag']}));
 const value=undone(taxonomy.value,first.receipt);assert.deepEqual(value.parts!.map(part=>part.id),['two','one']);assert.equal(value.parts![0].stemMarkdown,'手动改了第二小题。');assert.equal(value.parts![1].answerMarkdown,'答案one');assert.deepEqual(value.tagIds,['new-tag']);assert.equal(value.stemMarkdown,'公共材料。');
 assert.equal(applyAiQuestionEditSuggestion({...base,parts:[part('two')]},base,suggestion('removed',{answerMarkdown:'新答案。'},'one')).ok,false);
 assert.equal(applyAiQuestionEditSuggestion({...base,parts:[part('one',{type:'essay'}),part('two')]},base,suggestion('type',{answerMarkdown:'新答案。'},'one')).ok,false);
 assert.equal(applyAiQuestionEditSuggestion(base,base,suggestion('forbidden-taxonomy',{tagIds:['hidden']},'one')).ok,false);
});

test('taxonomy proposals guard category and tag dependencies in both application and undo without blocking prose',()=>{
 const base=question({categoryIds:['computer'],tagIds:[]});
 // Both proposals can be valid alone: a different empty-tag domain, or a tag
 // from the original domain. Combining old analyses would cross the domains.
 const moved=applied(base,base,suggestion('domain',{categoryIds:['chemistry']}));
 const oldTag=applyAiQuestionEditSuggestion(moved.value,base,suggestion('old-tag',{tagIds:['computer-network']}));assert.equal(oldTag.ok,false);if(!oldTag.ok)assert.deepEqual(oldTag.fields,['categoryIds']);
 const explanation=applied(moved.value,base,suggestion('prose',{explanationMarkdown:'补充推导过程。'}));assert.equal(explanation.value.explanationMarkdown,'补充推导过程。');
 const laterManualTag={...moved.value,tagIds:['chemical-reaction']};assert.equal(undoAiQuestionEditSuggestion(laterManualTag,moved.receipt).ok,false);
 const tagged=applied(base,base,suggestion('tag',{tagIds:['computer-network']}));
 assert.equal(applyAiQuestionEditSuggestion(tagged.value,base,suggestion('move-after-tag',{categoryIds:['chemistry']})).ok,false);
 assert.equal(undoAiQuestionEditSuggestion({...tagged.value,categoryIds:['another-domain']},tagged.receipt).ok,false);
 assert.deepEqual(undone(explanation.value,moved.receipt).categoryIds,['computer']);
});

test('proposal and receipt snapshots do not alias mutable model arrays, and optional blank absence is restored',()=>{
 const blank={id:'b',label:'空位',answers:['原子性'],caseSensitive:false,trim:true};
 const base=question({type:'fill_blank',blanks:[blank]}),model=suggestion('blank',{blanks:[{...blank,answers:['原子性','atomicity']}]});
 const first=applied(base,base,model);model.changes.blanks![0].answers.push('模型对象被外部修改');first.value.blanks![0].answers.push('用户手动修改');
 assert.deepEqual(first.receipt.after.blanks![0].answers,['原子性','atomicity']);assert.deepEqual(base.blanks![0].answers,['原子性']);assert.equal(undoAiQuestionEditSuggestion(first.value,first.receipt).ok,false);
 const empty=question(),added=applied(empty,empty,suggestion('empty-blanks',{blanks:[]}));assert.equal(Object.hasOwn(added.value,'blanks'),true);const value=undone(added.value,added.receipt);assert.equal(Object.hasOwn(value,'blanks'),false);
});

test('saving does not consume a receipt; undo produces an ordinary new local edit without touching persisted data',()=>{
 const base=question({status:'published'}),first=applied(base,base,suggestion('clarify',{explanationMarkdown:'补充必要条件。'}));
 const persisted=structuredClone(first.value),afterSave={...structuredClone(persisted),sourceAnchor:'用户在保存后更新了来源位置'};
 const local=undone(afterSave,first.receipt);assert.equal(local.explanationMarkdown,base.explanationMarkdown);assert.equal(local.status,'published');assert.equal(local.sourceAnchor,'用户在保存后更新了来源位置');assert.equal(persisted.explanationMarkdown,'补充必要条件。');
});

test('unsafe patch boundaries and changed identities fail without changing the original input',()=>{
 const base=question(),copy=structuredClone(base);
 for(const changes of [{},{status:'published'},{id:'OTHER'},{type:'essay'},{parts:[]},{stemMarkdown:undefined},{stemMarkdown:42},JSON.parse('{"__proto__":{"polluted":true},"answerMarkdown":"x"}'),{options:[{key:'A',text:'A',unknown:'x'}]}]){
  const result=applyAiQuestionEditSuggestion(base,base,suggestion('bad',changes as AiQuestionEditChanges));assert.equal(result.ok,false,JSON.stringify(changes));
 }
 const noChange=applyAiQuestionEditSuggestion({...base,title:'手动标题'},base,suggestion('noop',{title:base.title}));assert.equal(noChange.ok,false);if(!noChange.ok)assert.equal(noChange.code,'no_change');
 const good=suggestion('good',{answerMarkdown:'新答案'});assert.equal(applyAiQuestionEditSuggestion({...base,id:'Q2'},base,good).ok,false);assert.equal(applyAiQuestionEditSuggestion({...base,type:'essay'},base,good).ok,false);
 const first=applied(base,base,good);assert.equal(undoAiQuestionEditSuggestion({...first.value,id:'Q2'},first.receipt).ok,false);
 assert.equal(undoAiQuestionEditSuggestion(first.value,{...first.receipt,fields:['status']} as unknown as AiQuestionEditReceipt).ok,false);assert.deepEqual(base,copy);assert.equal(({} as Record<string,unknown>).polluted,undefined);
});
