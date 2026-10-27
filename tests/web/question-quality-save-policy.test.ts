import test from 'node:test';
import assert from 'node:assert/strict';
import {unchangedActiveQualityIssues,type QualitySaveState} from '../../web/features/questions/question-quality-save-policy.js';
const issue=(id:string,status:QualitySaveState['status']='open',rule:QualitySaveState['rule']='user_feedback'):QualitySaveState=>({id,status,rule});

test('only active questions without a deliberate status decision need the save reminder',()=>{
 const baseline=[issue('untouched'),issue('confirmed'),issue('resolved'),issue('dismissed'),issue('old-stale'),issue('reviewed','confirmed')];
 const latest=[issue('untouched'),issue('confirmed','confirmed'),issue('resolved','resolved'),issue('dismissed','dismissed'),issue('old-stale','stale'),issue('reviewed','confirmed'),issue('new-feedback')];
 assert.deepEqual(unchangedActiveQualityIssues(baseline,latest).map(value=>value.id),['untouched','old-stale','reviewed','new-feedback']);
 assert.deepEqual(unchangedActiveQualityIssues([],[]),[]);
});

test('retired automatic fields never trigger a reminder, while unresolved siblings remain independent',()=>{
 const before=[issue('first'),issue('second'),issue('source','open','missing_source'),issue('explanation','open','missing_explanation')];
 const current=[issue('first','resolved'),issue('second'),issue('source','open','missing_source'),issue('explanation','stale','missing_explanation')];
 assert.deepEqual(unchangedActiveQualityIssues(before,current),[issue('second')]);
 const snapshot=structuredClone(before);unchangedActiveQualityIssues(before,current);assert.deepEqual(before,snapshot);
});

test('updating review metadata or changing old evidence to stale does not replace an explicit triage decision',()=>{
 const before=[issue('meta'),issue('scanned','confirmed')];
 assert.deepEqual(unchangedActiveQualityIssues(before,[{...issue('meta'),updatedAt:'2099'} as QualitySaveState,issue('scanned','stale')]).map(value=>value.id),['meta','scanned']);
 assert.deepEqual(unchangedActiveQualityIssues([issue('reopened','resolved')],[issue('reopened','open')]),[]);
});
