import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { replaceCurrentHashLocation } from '../../web/shared/lib/route-location.js';

function browserLocation(t: TestContext, hash: string) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const writes: Array<{ state: unknown; url: string }> = [];
  const browser = {
    location: { hash },
    history: {
      state: { noeticAtlasNavigationIndex: 7, returnTo: '#/papers' },
      replaceState(state: unknown, _unused: string, url: string) {
        writes.push({ state, url });
        browser.location.hash = url;
      },
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  return { browser, writes };
}

test('same-page normalization preserves filters, pagination and the existing navigation entry', (t) => {
  const { browser, writes } = browserLocation(t, '#/documents?search=TCP&page=2&pageSize=20');
  const target = '#/documents?search=TCP&page=2';
  assert.equal(replaceCurrentHashLocation(target), true);
  assert.equal(browser.location.hash, target);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].state, browser.history.state);
});

test('a late normalization effect cannot take back a route the user has just opened', (t) => {
  const { browser, writes } = browserLocation(t, '#/questions?domainId=computer');
  const pendingEffect = () => replaceCurrentHashLocation('#/questions?domainId=computer&page=2');
  browser.location.hash = '#/tasks';
  assert.equal(pendingEffect(), false);
  assert.equal(browser.location.hash, '#/tasks');
  assert.deepEqual(writes, []);
});

test('a set normalization cannot replace another set or its independent question reader', (t) => {
  const { browser, writes } = browserLocation(t, '#/papers/set-b?tab=history');
  const target = '#/papers/set-a?tab=wrong&learningPage=2';
  for (const next of [
    '#/papers/set-b?tab=history',
    '#/papers/set-a/questions/question-1',
    '#/papers/set-a/activity?tab=history',
  ]) {
    browser.location.hash = next;
    assert.equal(replaceCurrentHashLocation(target), false);
    assert.equal(browser.location.hash, next);
  }
  assert.deepEqual(writes, []);
});

test('an already normalized location does not rewrite history', (t) => {
  const { writes } = browserLocation(t, '#/analytics?tab=ai&mode=all');
  assert.equal(replaceCurrentHashLocation('#/analytics?tab=ai&mode=all'), false);
  assert.deepEqual(writes, []);
});
