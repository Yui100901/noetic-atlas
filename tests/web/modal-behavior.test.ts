import test from 'node:test';
import assert from 'node:assert/strict';
import {lockModalScroll} from '../../web/shared/ui/modal-behavior.js';

test('nested modal scroll locks survive out-of-order cleanup and duplicate release',()=>{
 const body={style:{overflow:'scroll'}} as HTMLElement;
 const parent=lockModalScroll(body),child=lockModalScroll(body);assert.equal(body.style.overflow,'hidden');
 parent();assert.equal(body.style.overflow,'hidden');parent();assert.equal(body.style.overflow,'hidden');child();assert.equal(body.style.overflow,'scroll');
 const next=lockModalScroll(body);assert.equal(body.style.overflow,'hidden');next();assert.equal(body.style.overflow,'scroll');
});
