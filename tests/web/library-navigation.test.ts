import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters } from '../../web/shared/lib/learning-filters.js';
import { libraryLocation, readLibraryLocation, safeLibraryReturn, libraryQuestionHref, libraryReturnFromHash } from '../../web/features/questions/library-navigation.js';

test('library URLs preserve every filter, pagination and page size through a question and edit return',()=>{
  const filters={...emptyFilters,search:'天气 % # 与 &',domainId:'地理',categoryId:'weather',tagIds:['a','标签'],tagMode:'any',type:'fill_blank',difficulty:'2',depth:'3',frequency:'0',collection:'general',status:'all',favorite:true,wrong:true,due:true};
  const back=libraryLocation(filters,4,50);
  assert.deepEqual(readLibraryLocation(back),{filters,page:4,pageSize:50});
  assert.equal(libraryReturnFromHash(libraryQuestionHref('题目::1',back)),back);
  assert.equal(libraryReturnFromHash(libraryQuestionHref('题目::1',back,true)),back);
  assert.match(libraryQuestionHref('题目::1',back,true),/\/edit\?returnTo=/);
});
test('return destinations cannot become external URLs, other pages or nested redirect payloads',()=>{
  for(const value of ['https://evil.example/','#/settings','#/questions/unsafe','javascript:alert(1)','#//questions','%23%2Fquestions'])assert.equal(safeLibraryReturn(value),'#/questions');
  assert.equal(safeLibraryReturn('#/questions?returnTo=https://evil.example&domainId=geo'),'#/questions?domainId=geo');
  assert.equal(libraryLocation({...emptyFilters}),'#/questions');
  assert.equal(libraryQuestionHref('Q'),'#/questions/Q');
});
test('restored filters reject unsupported control values and unbounded pages but retain literal search text',()=>{
  const state=readLibraryLocation('#/questions?page=-1&pageSize=15&type=unsupported&difficulty=99&frequency=0&tagIds=a,a,bad%2Fid&search=%3Cscript%3E&due=1');
  assert.equal(state.page,1);assert.equal(state.pageSize,20);assert.equal(state.filters.type,'');assert.equal(state.filters.difficulty,'');assert.equal(state.filters.frequency,'0');assert.deepEqual(state.filters.tagIds,['a']);assert.equal(state.filters.search,'<script>');assert.equal(state.filters.due,true);
});
