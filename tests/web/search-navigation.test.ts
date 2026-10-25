import test from 'node:test';
import assert from 'node:assert/strict';
import { readSearchState, searchHref, searchHighlights, searchInputError, searchResultHref, searchReturnTarget } from '../../web/features/search/search-navigation.js';

test('search URL preserves query, filters, sort and paging across a detail round trip', () => {
  const state = { q: 'C++ 搜索 #%_', type: 'note' as const, sort: 'updatedAt' as const, includeUnpublished: true, page: 3, pageSize: 50 };
  const href = searchHref(state); assert.deepEqual(readSearchState(href), state);
  const detail = searchResultHref('#/questions/group-id?part=child', state)!;
  assert.equal(new URLSearchParams(detail.split('?')[1]).get('part'), 'child');
  assert.equal(searchReturnTarget(detail), href);
});

test('search return destinations cannot escape the local results page or retain nested redirects', () => {
  for (const target of ['https://example.test/', 'javascript:alert(1)', '#/settings', '#/searching?q=x', '#/search/child', '#/search?q=' + 'x'.repeat(101)]) {
    assert.equal(searchReturnTarget('#/questions/q?returnTo=' + encodeURIComponent(target)), null, target);
  }
  assert.equal(searchReturnTarget('#/search?returnTo=' + encodeURIComponent('#/search?q=loop')), null);
  const target = '#/search?q=valid&type=question&page=2&returnTo=https://example.test&unknown=secret';
  assert.equal(searchReturnTarget('#/questions/q?returnTo=' + encodeURIComponent(target)), '#/search?q=valid&type=question&page=2');
  for (const href of ['javascript:alert(1)', 'https://example.test', '//example.test', 'data:text/html,hi']) assert.equal(searchResultHref(href, readSearchState('#/search?q=x')), null);
});

test('search input and restored URL values apply bounded public filters', () => {
  const restored = readSearchState('#/search?q=test&type=invalid&sort=invalid&page=-1&pageSize=999&includeUnpublished=1');
  assert.deepEqual(restored, { q: 'test', type: 'all', sort: 'relevance', page: 1, pageSize: 20, includeUnpublished: false });
  assert.equal(searchInputError('a b c d e f g h'), ''); assert.ok(searchInputError('a b c d e f g h i')); assert.ok(searchInputError('x'.repeat(101)));
  assert.equal(searchInputError('　'), '');
});

test('highlighting maps normalized Unicode back to complete original graphemes', () => {
  const text = 'ＡＰＩ ffi ﬃ 👩🏽‍💻 e\u0301';
  const segments = searchHighlights(text, 'api ffi 👩🏽‍💻 é');
  assert.equal(segments.map(segment => segment.text).join(''), text);
  const marked = segments.filter(segment => segment.matched).map(segment => segment.text);
  for (const fragment of ['ＡＰＩ', 'ffi', 'ﬃ', '👩🏽‍💻', 'e\u0301']) assert.ok(marked.some(value => value.includes(fragment)), fragment);
});

test('highlighting keeps HTML, regex and SQL characters as literal text', () => {
  const text = '<script>alert(1)</script> 100%_ [a-z]';
  for (const query of ['<script>', '100%_', '[a-z]']) {
    const segments = searchHighlights(text, query);
    assert.equal(segments.map(segment => segment.text).join(''), text);
    assert.ok(segments.some(segment => segment.matched && segment.text === query));
  }
  assert.deepEqual(searchHighlights(text, ''), [{ text, matched: false }]);
});
