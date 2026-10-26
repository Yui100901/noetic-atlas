import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaperContentsContext, paperContentsHref, paperQuestionHref, readPaperContentsContext } from '../../web/features/papers/reader-navigation.js';

const query = (href: string) => new URLSearchParams(href.split('?')[1] || '');

test('paper reader links round-trip list search, page and page size with Unicode and grouped leaf IDs', () => {
  const context = { search: '事务 TCP C++ #%_ / 👩🏽‍💻', page: 3, pageSize: 50 };
  const paperId = '题集 / #?% 中文', questionId = 'GROUP / 汉字::小题?/#%';
  const reading = paperQuestionHref(paperId, questionId, context);
  const route = reading.split('?')[0].split('/');
  assert.deepEqual(route.slice(0, 2), ['#', 'papers']);
  assert.equal(route.length, 5, 'encoded path separators must remain inside their own route segment');
  assert.equal(decodeURIComponent(route[2]), paperId);
  assert.equal(route[3], 'questions'); assert.equal(decodeURIComponent(route[4]), questionId);
  assert.deepEqual(readPaperContentsContext(query(reading)), context);
  const returning = paperContentsHref(paperId, readPaperContentsContext(query(reading)));
  assert.equal(query(returning).get('tab'), 'content');
  assert.deepEqual(readPaperContentsContext(query(returning)), context);
  assert.equal(returning.split('?')[0], '#/papers/' + encodeURIComponent(paperId));
});

test('default reader routes stay short while set-return routes explicitly open the content tab', () => {
  assert.deepEqual(readPaperContentsContext(new URLSearchParams()), { search: '', page: 1, pageSize: 20 });
  assert.equal(paperQuestionHref('P1', 'Q1'), '#/papers/P1/questions/Q1');
  assert.equal(paperQuestionHref('P1', 'GROUP::child', { search: '', page: 1, pageSize: 20 }), '#/papers/P1/questions/GROUP%3A%3Achild');
  assert.equal(paperContentsHref('P1'), '#/papers/P1?tab=content');
  for (const pageSize of [10, 20, 50, 100]) {
    const href = paperQuestionHref('P1', 'Q1', { pageSize });
    assert.equal(readPaperContentsContext(query(href)).pageSize, pageSize);
  }
});

test('invalid pagination and repeated known parameters normalize deterministically', () => {
  for (const raw of ['-1', '0', '1.5', 'Infinity', 'NaN', '1e2', '0x10', ' 2 ', '1000001', '9007199254740993']) {
    assert.equal(readPaperContentsContext(new URLSearchParams({ contentsPage: raw })).page, 1, raw);
  }
  for (const raw of ['0', '-20', '15', '200', '20.5', '2e1', ' 20 ']) {
    assert.equal(readPaperContentsContext(new URLSearchParams({ contentsPageSize: raw })).pageSize, 20, raw);
  }
  assert.deepEqual(readPaperContentsContext(new URLSearchParams('contentsPage=0002&contentsPageSize=010')), { search: '', page: 2, pageSize: 10 });
  assert.deepEqual(readPaperContentsContext(new URLSearchParams('contentsSearch=first&contentsSearch=second&contentsPage=2&contentsPage=3&contentsPageSize=10&contentsPageSize=100')), { search: '', page: 1, pageSize: 20 });
  assert.deepEqual(normalizePaperContentsContext({ search: 4, page: '2', pageSize: '50' } as any), { search: '', page: 1, pageSize: 20 });
  assert.deepEqual(normalizePaperContentsContext({ page: 1_000_000, pageSize: 100 }), { search: '', page: 1_000_000, pageSize: 100 });
});

test('list context retains literal input within bounds without cutting a surrogate pair', () => {
  const literal = '  <script>alert(1)</script> C++ & ? = + % \\  ';
  assert.equal(readPaperContentsContext(query(paperQuestionHref('P1', 'Q1', { search: literal }))).search, literal);
  const exact = '字'.repeat(1000);
  assert.equal(normalizePaperContentsContext({ search: exact }).search, exact);
  const crossing = 'x'.repeat(999) + '😀tail';
  const bounded = normalizePaperContentsContext({ search: crossing }).search;
  assert.equal(bounded, 'x'.repeat(999)); assert.ok(bounded.length <= 1000);
  assert.equal(normalizePaperContentsContext({ search: '😀'.repeat(501) }).search, '😀'.repeat(500));
  assert.equal(normalizePaperContentsContext({ search: 'a\udc00b' }).search, 'a\ufffdb');
  assert.doesNotThrow(() => paperQuestionHref('P\ud800', 'Q\udc00', { search: crossing }));
});

test('reader navigation never copies unknown fields or accepts an arbitrary return destination', () => {
  const params = new URLSearchParams('tab=history&returnTo=https%3A%2F%2Fexample.test&redirect=javascript%3Aalert(1)&contentsSearch=valid&contentsPage=2&contentsPageSize=10');
  const context = readPaperContentsContext(params);
  const returning = paperContentsHref('P1', { ...context, returnTo: '//example.test', redirect: '#/settings' } as any);
  assert.equal(returning, '#/papers/P1?tab=content&contentsSearch=valid&contentsPage=2&contentsPageSize=10');
  const reading = paperQuestionHref('https://example.test/#/evil', 'javascript:alert(1)', context);
  assert.ok(reading.startsWith('#/papers/https%3A%2F%2Fexample.test%2F%23%2Fevil/questions/javascript%3Aalert(1)'));
  assert.equal(query(reading).get('returnTo'), null); assert.equal(query(reading).get('redirect'), null);
});
