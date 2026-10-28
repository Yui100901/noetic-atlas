import test from 'node:test';
import assert from 'node:assert/strict';
import {documentHref,documentListLocation,documentReturnFromHash,readDocumentListLocation,safeDocumentReturn} from '../../web/features/library/document-navigation.js';

test('document navigation preserves every filter and paging through reading, editing and creation',()=>{
 const state={search:'风和雨 % # &',collection:'general',kind:'书籍',domainId:'地理',categoryId:'climate',tagId:'标签',format:'markdown',page:3,pageSize:50};
 const back=documentListLocation(state);assert.deepEqual(readDocumentListLocation(back),state);
 for(const target of [documentHref('文档-1',back),documentHref('文档-1',back,true),documentHref('new',back)])assert.equal(documentReturnFromHash(target),back);
 assert.match(documentHref('文档-1',back,true),/\/edit\?returnTo=/);assert.equal(documentHref('DOC'),'#/documents/DOC');
});
test('document returns allow only a normalized library list and cannot retain nested redirects',()=>{
 for(const value of ['https://evil.example/','#/settings','#/documents/1','javascript:alert(1)','#//documents','%23%2Fdocuments'])assert.equal(safeDocumentReturn(value),'#/documents');
 assert.equal(safeDocumentReturn('#/documents?returnTo=https://evil.example&domainId=geo&unknown=value'),'#/documents?domainId=geo');
 assert.equal(documentReturnFromHash('#/documents/DOC?returnTo='+encodeURIComponent('#/settings')),'#/documents');
});
test('document URL state bounds pages and known choices while preserving literal text safely',()=>{
 const value=readDocumentListLocation('#/documents?page=-1&pageSize=15&collection=admin&format=html&categoryId=bad%2Fid&search=%3Cscript%3E&kind=自定义类型');
 assert.equal(value.page,1);assert.equal(value.pageSize,20);assert.equal(value.collection,'');assert.equal(value.format,'');assert.equal(value.categoryId,'');assert.equal(value.search,'<script>');assert.equal(value.kind,'自定义类型');
 assert.ok(readDocumentListLocation('#/documents?search='+encodeURIComponent('x'.repeat(499)+'😀')).search.length<=500);
});
