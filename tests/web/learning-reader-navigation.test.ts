import test from 'node:test';
import assert from 'node:assert/strict';
import {learningListHref,learningQuestionsUrl,learningReaderHref,readLearningReader,readLearningPagination,type LearningReaderContext} from '../../web/features/practice/learning-reader-navigation.js';
const query=(href:string)=>new URLSearchParams(href.split('?')[1]);
test('special set readers preserve scope, unique leaf identity and list pagination across Unicode links',()=>{
 const key=JSON.stringify(['原题 / ?#%','小题:🌍']);
 for(const scope of ['global','paper','quick']as const){
  const context:LearningReaderContext={scope,kind:'wrong',paperId:'题集 / ?#%',tab:'wrong',activity:scope==='paper',page:3,pageSize:10};
  const href=learningReaderHref(context,key),parsed=readLearningReader(query(href))!;
  assert.equal(parsed.itemKey,key);assert.equal(parsed.context.scope,scope);assert.equal(parsed.context.page,3);assert.equal(parsed.context.pageSize,10);
  const back=learningListHref(parsed.context);assert.deepEqual(readLearningPagination(query(back)),{page:3,pageSize:10});
  if(scope==='paper')assert.ok(back.startsWith('#/papers/'+encodeURIComponent(context.paperId!)+'/activity?tab=wrong'));
 }
});
test('review queue readers round-trip queue filters and task directions without changing the task identity',()=>{
 const context:LearningReaderContext={scope:'queue',kind:'due',page:2,pageSize:50,queueKind:'relearning',domainId:'cs',categoryId:'child',direction:'meaning_to_word'};
 const parsed=readLearningReader(query(learningReaderHref(context,'["GROUP","child","meaning_to_word"]')))!;
 assert.deepEqual(parsed.context,context);const back=learningListHref(parsed.context),params=query(back);
 assert.equal(params.get('queueDirection'),'meaning_to_word');assert.equal(params.get('queueKind'),'relearning');assert.deepEqual(readLearningPagination(params,true),{page:2,pageSize:50});
 const url=learningQuestionsUrl(context,3);assert.ok(url.startsWith('/api/review-scheduler/queue?'));assert.equal(query(url).get('page'),'3');assert.equal(query(url).get('categoryId'),'child');
});
test('context review favorites return to their review tab instead of the standalone favorite tab',()=>{
 const parsed=readLearningReader(query(learningReaderHref({scope:'paper',kind:'favorite',paperId:'P1',tab:'review',page:1,pageSize:20},'Q1')))!;
 assert.equal(learningListHref(parsed.context),'#/papers/P1?tab=review&reviewKind=favorite');
 assert.equal(learningQuestionsUrl(parsed.context),'/api/learning/questions?page=1&pageSize=20&kind=favorite&source=paper&paperId=P1');
});
test('reader context rejects incomplete or ambiguous identities and cannot introduce arbitrary return destinations',()=>{
 for(const raw of ['scope=unknown&item=Q1','scope=paper&item=Q1','scope=global','scope=global&item=Q1&item=Q2'])assert.equal(readLearningReader(new URLSearchParams(raw)),null);
 const parsed=readLearningReader(new URLSearchParams('scope=global&kind=favorite&item=Q1&page=-1&pageSize=7&returnTo=https%3A%2F%2Fevil.test&tab=history'))!;
 assert.equal(learningListHref(parsed.context),'#/learning/favorite');assert.equal(learningReaderHref(parsed.context,parsed.itemKey).includes('returnTo'),false);
 assert.deepEqual(readLearningPagination(new URLSearchParams('learningPage=2&learningPage=3&learningPageSize=1000000')),{page:1,pageSize:20});
});
