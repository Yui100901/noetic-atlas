import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePaperListContext,paperListHref,readPaperListContext} from '../../web/features/papers/list-navigation.js';

test('paper list URLs preserve search, organization, archives and pagination through a canonical route',()=>{
 const context={search:'资料 A&B / 你好',organization:'domain:computer',showArchived:true,page:3,pageSize:10};
 const url=paperListHref(context);assert.ok(url.startsWith('#/papers?'));assert.deepEqual(readPaperListContext(url),context);
 assert.equal(paperListHref(normalizePaperListContext()),'#/papers');
});
test('paper list context cannot introduce routes, nested redirects, duplicate parameters or unbounded values',()=>{
 const context=readPaperListContext('#/papers?organization=https://evil.invalid&page=-1&pageSize=999&archived=true&returnTo=https://evil.invalid&search=a&search=b');
 assert.deepEqual(context,normalizePaperListContext());assert.equal(paperListHref(context),'#/papers');
 assert.equal(normalizePaperListContext({organization:'domain:../../secret'}).organization,'all');
 assert.equal(normalizePaperListContext({page:Infinity,pageSize:1}).page,1);assert.equal(normalizePaperListContext({search:'x'.repeat(999)+'😀'}).search,'x'.repeat(999));
});
