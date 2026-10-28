import test from 'node:test';
import assert from 'node:assert/strict';
import { managementEditorHref, managementLocation, readManagementContext, readManagementLocation, safeManagementReturn } from '../../web/features/questions/management-navigation.js';

test('review editor navigation preserves the original review search, domain and page instead of entering a learning view',()=>{
  const state={search:'自然地理 % & #',domainId:'地理',page:3,pageSize:50};
  const back=managementLocation('review',state),href=managementEditorHref('待审::1',back);
  assert.deepEqual(readManagementLocation(back),{kind:'review',...state});
  assert.match(href,/^#\/questions\/.*\/edit\?returnTo=/);
  assert.deepEqual(readManagementContext(href),{kind:'review',returnTo:back,label:'审核管理'});
  assert.equal(managementLocation('review'), '#/questions/review');
});

test('quality editor navigation retains all quality filters and independently locates a specific issue',()=>{
  const state={search:'反馈：单位是否错误？',domainId:'physics',status:'resolved',origin:'feedback',severity:'warning',rule:'user_feedback',questionId:'Q:1',scanId:'scan-1',page:7,pageSize:100};
  const back=managementLocation('quality',state),href=managementEditorHref('Q:1',back,'quality-feedback-2');
  assert.deepEqual(readManagementLocation(back),{kind:'quality',...state});
  assert.deepEqual(readManagementContext(href),{kind:'quality',returnTo:back,label:'质量管理',issueId:'quality-feedback-2'});
  assert.equal(managementLocation('quality',{status:'active',origin:'all',page:1,pageSize:20}), '#/content-quality');
});

test('management returns reject external and other pages, strip nested destinations and do not promote invalid issue identifiers',()=>{
  for(const value of ['https://evil.example','#/settings','#/questions','#/questions/review/extra','#//content-quality','javascript:alert(1)','%23%2Fcontent-quality'])assert.equal(safeManagementReturn(value),null,value);
  assert.equal(safeManagementReturn('#/questions/review?returnTo=https://evil.example&qualityIssueId=Q&domainId=geo'),'#/questions/review?domainId=geo');
  assert.equal(safeManagementReturn('#/content-quality?issueId=old&feedbackId=old&returnTo=%23%2Fsettings&domainId=geo'),'#/content-quality?domainId=geo');
  assert.equal(readManagementContext('#/questions/Q/edit?returnTo=https%3A%2F%2Fevil.example'),null);
  assert.deepEqual(readManagementContext(managementEditorHref('Q','#/questions/review','feedback-1')),{kind:'review',returnTo:'#/questions/review',label:'审核管理'});
  for(const issue of ['bad/id','__proto__','constructor','x'.repeat(161)])assert.deepEqual(readManagementContext(managementEditorHref('Q','#/content-quality',issue)),{kind:'quality',returnTo:'#/content-quality',label:'质量管理'});
  assert.deepEqual(readManagementContext(managementEditorHref('Q','https://evil.example')),{kind:'quality',returnTo:'#/content-quality',label:'质量管理'});
});

test('management filter normalization bounds values, drops invalid enums and retired rules, and round-trips Unicode safely',()=>{
  const state=readManagementLocation('#/content-quality?page=-8&pageSize=15&status=unsafe&origin=web&severity=critical&rule=missing_explanation&domainId=bad%2Fid&questionId=constructor&scanId=ok&unknown=1');
  assert.deepEqual(state,{kind:'quality',search:'',domainId:'',page:1,pageSize:20,status:'active',origin:'all',severity:'',rule:'',questionId:'',scanId:'ok'});
  const review=managementLocation('review',{search:'😀'.repeat(100000),domainId:'x'.repeat(100000),page:2_000_000,pageSize:15});
  const normalized=readManagementLocation(review)!;
  assert.equal(normalized.search.length,500);assert.ok(!/[\uD800-\uDBFF]$/.test(normalized.search));assert.equal(normalized.domainId,'');assert.equal(normalized.page,1);assert.equal(normalized.pageSize,20);
  assert.equal(safeManagementReturn('#/content-quality?search='+'x'.repeat(20001)),null);
  assert.equal(readManagementLocation('#/questions/review?page=2&page=999')!.page,2);
});
