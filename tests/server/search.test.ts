import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { searchQuerySchema } from '../../server/modules/search/schema.js';
import { unifiedSearch } from '../../server/modules/search/service.js';
import { studyPartKey } from '../../shared/questions/study-state.js';

function fixture(t: test.TestContext, path = ':memory:') {
  const store = new Store(path); t.after(() => store.db.close());
  store.put('domains', 'domain-one', { id: 'domain-one', name: '共同领域', description: 'COMMON 基础', sortOrder: 0 });
  store.put('categories', 'category-one', { id: 'category-one', domainId: 'domain-one', name: '共同分类', description: 'COMMON 分类说明', parentId: null, sortOrder: 0 });
  store.put('tags', 'tag-one', { id: 'tag-one', name: '共同标签', description: 'COMMON 标签说明', color: '#336699', domainId: 'domain-one', kind: 'topic' });
  const question = questionSchema.parse({ id: 'COMMON-Q', title: 'COMMON', type: 'short_answer', stemMarkdown: 'COMMON stem with literal %_ and snake_case', answerMarkdown: 'PRIVATE_REFERENCE_CANARY aardvark definition', explanationMarkdown: 'REFERENCE_EXPLANATION_CANARY', categoryIds: ['category-one'], tagIds: ['tag-one'], status: 'published' });
  store.put('questions', question.id, question);
  store.put('papers', 'paper-one', { id: 'paper-one', title: 'COMMON 题集', description: 'COMMON paper summary', archived: false, domainId: 'domain-one', questionIds: [question.id], snapshot: [question], updatedAt: '2026-10-20T00:00:00Z' });
  store.put('documents', 'doc-one', { id: 'doc-one', title: 'COMMON资料', kind: '书籍', description: '资料简介', bodyMarkdown: 'COMMON documentation正文 deep-markdown-needle', categoryIds: ['category-one'], format: 'markdown', author: 'AuthorName', updatedAt: '2026-10-22T00:00:00Z' });
  store.put('study', question.id, { questionId: question.id, notes: 'COMMON private note', favorite: false, mastery: null, nextReviewAt: null, lastReviewedAt: null, wrongCount: 0 });
  const search = (q: string, options: Record<string, unknown> = {}) => unifiedSearch(store, searchQuerySchema.parse({ q, ...options }));
  return { store, question, search };
}

test('unified search returns seven typed collections with exact-title ranking, safe excerpts and accurate selected totals', t => {
  const { search } = fixture(t);
  const all = search('common'); assert.equal(all.totalAll, 7); assert.equal(all.total, 7); assert.equal(all.items.length, 7);
  assert.deepEqual(all.counts, { question: 1, paper: 1, document: 1, note: 1, domain: 1, category: 1, tag: 1 });
  assert.equal(all.items[0].type, 'question'); assert.equal(all.items[0].matchIn, 'title'); assert.equal(all.items[0].excerpt, 'COMMON stem with literal %_ and snake_case');
  assert.deepEqual(all.items.find(item => item.type === 'note')!.domainIds, ['domain-one']);
  assert.equal(all.items.find(item => item.type === 'note')!.updatedAt, undefined);
  const selected = search('common', { type: 'document' }); assert.equal(selected.total, 1); assert.equal(selected.totalAll, 7); assert.equal(selected.items[0].id, 'doc-one');
  assert.equal(search('aardvark').items[0].matchIn, 'reference');
  assert.doesNotMatch(JSON.stringify(search('aardvark')), /PRIVATE_REFERENCE_CANARY|REFERENCE_EXPLANATION_CANARY|definition/);
});

test('normalization handles Unicode width/case, literal punctuation and AND terms without SQL wildcard behavior', t => {
  const { store, question, search } = fixture(t);
  store.put('questions', question.id, { ...question, title: 'Ｃｏｍｍｏｎ café', stemMarkdown: question.stemMarkdown + ' quote\' test' });
  assert.equal(search('COMMON café').counts.question, 1);
  assert.equal(search('%_').counts.question, 1); assert.equal(search('snake_case').counts.question, 1);
  assert.equal(search('quote\'').counts.question, 1);
  assert.equal(search("' OR 1=1 --").total, 0);
  assert.equal(search('COMMON missing-AND-token').total, 0);
  assert.equal(search('COMMON-Q').items[0].matchIn, 'id');
});

test('archived entities are excluded and unpublished question/notes require an explicit option', t => {
  const { store, question, search } = fixture(t);
  for (const status of ['pending', 'draft', 'archived'] as const) {
    store.put('questions', status, { ...question, id: status, title: 'COMMON ' + status, status });
    store.put('study', status, { questionId: status, notes: 'COMMON note ' + status });
  }
  store.put('papers', 'archived-paper', { id: 'archived-paper', title: 'COMMON old paper', description: 'COMMON', archived: true });
  store.put('documents', 'archived-doc', { id: 'archived-doc', title: 'COMMON old doc', bodyMarkdown: 'COMMON', _archived: true });
  const base = search('COMMON'); assert.equal(base.counts.question, 1); assert.equal(base.counts.note, 1);
  const expanded = search('COMMON', { includeUnpublished: 'true' }); assert.equal(expanded.counts.question, 3); assert.equal(expanded.counts.note, 3);
  assert.equal(expanded.counts.paper, 1); assert.equal(expanded.counts.document, 1); assert.ok(!expanded.items.some(item => item.id === 'archived'));
});

test('group child content and part notes are searchable and follow parent edits or deletion', t => {
  const { store, question, search } = fixture(t);
  const group = questionSchema.parse({ id: 'group', title: '材料标题', type: 'group', stemMarkdown: '公共材料', categoryIds: ['category-one'], status: 'published', parts: [
    { id: 'first', title: 'first part', type: 'short_answer', stemMarkdown: 'CHILD_STEM_NEEDLE', answerMarkdown: 'CHILD_REFERENCE_CANARY' },
    { id: 'second', title: 'second part', type: 'true_false', stemMarkdown: '判断材料', correctAnswers: ['true'] },
  ] });
  store.put('questions', group.id, group);
  const partKey = studyPartKey(group.id, 'first'); store.put('study_parts', partKey, { questionId: group.id, partId: 'first', notes: 'PART_NOTE_NEEDLE' });
  assert.equal(search('CHILD_STEM_NEEDLE').items[0].id, group.id);
  let note = search('PART_NOTE_NEEDLE').items[0]; assert.equal(note.partId, 'first'); assert.equal(note.href, '#/questions/group?part=first');
  store.put('questions', group.id, { ...group, title: '修改材料标题' });
  note = search('PART_NOTE_NEEDLE').items[0]; assert.match(note.title, /修改材料标题/);
  store.put('questions', group.id, { ...group, parts: group.parts!.filter(part => part.id !== 'first') }); assert.equal(search('PART_NOTE_NEEDLE').total, 0);
  store.remove('questions', question.id); assert.equal(search('COMMON private note').total, 0);
});

test('Markdown body and PDF metadata are searchable while binary payloads, scripts and resource URLs stay out of the index', t => {
  const { store, search } = fixture(t);
  store.put('documents', 'pdf', { id: 'pdf', title: 'PDF_METADATANEEDLE', format: 'pdf', fileName: 'handbook.pdf', description: 'book about routing', author: 'ResearchAuthor', bodyMarkdown: 'PDF_BODY_NOT_SEARCHED', assetId: 'asset-private', dataBase64: 'BINARY_PRIVATE_CANARY' });
  store.put('documents', 'markdown-safe', { id: 'markdown-safe', title: '安全正文', format: 'markdown', bodyMarkdown: '<script>SCRIPT_PRIVATE_CANARY</script> ![diagram](/api/assets/RESOURCE_PRIVATE_CANARY/content) ![](data:image/png;base64,' + 'A'.repeat(2000) + ') legitimate-body-needle' });
  assert.equal(search('deep-markdown-needle').items[0].id, 'doc-one');
  assert.equal(search('ResearchAuthor').items[0].id, 'pdf'); assert.equal(search('PDF_BODY_NOT_SEARCHED').total, 0);
  assert.equal(search('legitimate-body-needle').items[0].id, 'markdown-safe');
  for (const value of ['BINARY_PRIVATE_CANARY', 'SCRIPT_PRIVATE_CANARY', 'RESOURCE_PRIVATE_CANARY', 'A'.repeat(100)]) assert.equal(search(value).total, 0);
  store.put('documents', 'unclosed-html', { id: 'unclosed-html', title: '未闭合HTML', format: 'markdown', bodyMarkdown: '可检索前文<script>UNCLOSED_SCRIPT_CANARY' });
  assert.equal(search('UNCLOSED_SCRIPT_CANARY').total, 0); assert.equal(search('可检索前文').items[0].id, 'unclosed-html');
  const index = store.db.all(store.db.query.selectFrom('search_read_model').select('search_text')).map(row => row.search_text).join('');
  assert.doesNotMatch(index, /base64|script_private|resource_private|binary_private/);
  assert.equal(search('routing').scope.pdf, 'metadata');
});

test('choices, blank prompts and normalized long-prefix excerpts remain discoverable without leaking standard answers', t => {
  const { store, question, search } = fixture(t);
  const choice = questionSchema.parse({ ...question, id: 'choice', title: '请选择', type: 'single_choice', stemMarkdown: '以下哪项正确？', options: [{ key: 'A', text: 'ONLY_OPTION_NEEDLE' }, { key: 'B', text: '另一个选项' }], correctAnswers: ['A'] });
  store.put('questions', choice.id, choice); assert.equal(search('ONLY_OPTION_NEEDLE').items[0].id, choice.id);
  const blank = questionSchema.parse({ ...question, id: 'blank', type: 'fill_blank', stemMarkdown: '请填写', blanks: [{ id: 'b', label: 'ONLY_LABEL_NEEDLE', answers: ['STANDARD_BLANK_CANARY'], caseSensitive: false, trim: true }] });
  store.put('questions', blank.id, blank); assert.equal(search('ONLY_LABEL_NEEDLE').items[0].id, blank.id);
  const answer = search('STANDARD_BLANK_CANARY'); assert.equal(answer.items[0].matchIn, 'reference'); assert.doesNotMatch(JSON.stringify(answer.items), /STANDARD_BLANK_CANARY/);
  store.put('documents', 'normalized', { id: 'normalized', title: '兼容字符', format: 'markdown', bodyMarkdown: 'ﬃｶﾞ'.repeat(300) + ' EXCERPT_NORMALIZATION_NEEDLE ' + '后文'.repeat(100) });
  const hit = search('EXCERPT_NORMALIZATION_NEEDLE'); assert.equal(hit.items[0].id, 'normalized'); assert.match(hit.items[0].excerpt, /EXCERPT_NORMALIZATION_NEEDLE/); assert.ok(hit.items[0].excerpt.length <= 220);
});

test('pagination and update sorting remain deterministic, detached pages keep totals and type counts ignore the selected tab', t => {
  const { store, question, search } = fixture(t);
  for (let index = 0; index < 25; index++) store.put('questions', 'page-' + index, { ...question, id: 'page-' + index, title: 'PAGINATION marker', updatedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00Z` });
  const first = search('pagination', { pageSize: 10, sort: 'updatedAt' }), second = search('pagination', { page: 2, pageSize: 10, sort: 'updatedAt' });
  assert.equal(first.total, 25); assert.equal(first.items[0].id, 'page-24'); assert.equal(second.items.length, 10);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.key)).size, 20);
  const detached = search('pagination', { page: 100, pageSize: 10 }); assert.equal(detached.items.length, 0); assert.equal(detached.total, 25); assert.equal(detached.counts.question, 25);
  store.put('questions', 'offset-older', { ...question, id: 'offset-older', title: 'OFFSET_SORT_NEEDLE', updatedAt: '2026-10-21T23:30:00+08:00' });
  store.put('questions', 'utc-newer', { ...question, id: 'utc-newer', title: 'OFFSET_SORT_NEEDLE', updatedAt: '2026-10-21T16:00:00Z' });
  assert.equal(search('OFFSET_SORT_NEEDLE', { sort: 'updatedAt' }).items[0].id, 'utc-newer');
});

test('broad searches materialize only one metadata row per page item while preserving all type counts', t => {
  const { store, question, search } = fixture(t);
  for (let index = 0; index < 35; index++) store.put('questions', 'broad-' + index, { ...question, id: 'broad-' + index, title: 'COMMON item ' + index });
  search('common'); // Complete the independent projection before observing reads.
  const all = store.db.all.bind(store.db); let returned = 0, metadata = 0;
  store.db.all = ((query: any) => {
    const rows = all(query); returned += rows.length;
    const records = rows.filter(row => typeof (row as any).data === 'string'); metadata += records.length;
    assert.equal(new Set(records.map(row => (row as any).key)).size, records.length, 'the count types must not multiply page records');
    return rows;
  }) as typeof store.db.all;
  const page = search('common', { pageSize: 20 });
  assert.equal(page.items.length, 20); assert.equal(metadata, 20); assert.equal(returned, 28, '7 type totals + 20 page records + 1 classification record');
  assert.deepEqual(page.counts, { question: 36, paper: 1, document: 1, note: 1, domain: 1, category: 1, tag: 1 });
  returned = 0; metadata = 0;
  const detached = search('common', { type: 'tag', page: 3, pageSize: 10 });
  assert.equal(detached.items.length, 0); assert.equal(detached.total, 1); assert.equal(detached.totalAll, 42);
  assert.equal(metadata, 0); assert.equal(returned, 7, 'empty selected pages retain all type totals without reading item metadata');
});

test('page-local relevance still distinguishes all seven ranking levels and deterministic ties', t => {
  const { store, question, search } = fixture(t), stamp = '2026-10-20T00:00:00Z';
  const samples = [
    { id: 'rankterm', title: 'unrelated', stemMarkdown: 'outside' },
    { id: 'rank-title', title: 'rankterm', stemMarkdown: 'outside' },
    { id: 'rankterm-prefix', title: 'unrelated', stemMarkdown: 'outside' },
    { id: 'rank-title-prefix', title: 'rankterm suffix', stemMarkdown: 'outside' },
    { id: 'rank-title-includes', title: 'preceding rankterm follows', stemMarkdown: 'outside' },
    { id: 'rank-content', title: 'unrelated', stemMarkdown: 'rankterm content' },
    { id: 'rank-reference', title: 'unrelated', stemMarkdown: 'outside', answerMarkdown: 'rankterm reference' },
  ];
  for (const sample of samples) store.put('questions', sample.id, { ...question, answerMarkdown: '', ...sample, updatedAt: stamp });
  for (const sort of ['relevance', 'updatedAt']) {
    const result = search('rankterm', { sort });
    assert.deepEqual(result.items.map(item => item.id), samples.map(sample => sample.id));
    assert.deepEqual(result.items.map(item => item.matchIn), ['id', 'title', 'id', 'title', 'title', 'content', 'reference']);
    assert.doesNotMatch(JSON.stringify(result.items), /rankterm reference/);
  }
});

test('projection updates are transactional and raw external writes invalidate affected sources without rewriting originals', t => {
  const folder = mkdtempSync(join(tmpdir(), 'atlas-search-'));
  const { store, question, search } = fixture(t, join(folder, 'source.sqlite'));
  assert.equal(store.db.schemaChanged, true); search('COMMON');
  const peer = new Store(join(folder, 'source.sqlite')); t.after(() => peer.db.close()); assert.equal(peer.db.schemaChanged, false);
  t.after(() => { assert.ok(folder.startsWith(join(tmpdir(), 'atlas-search-'))); rmSync(folder, { recursive: true, force: true }); });
  const row = { ...question, title: 'EXTERNAL_UPDATE_NEEDLE' };
  peer.db.run(peer.db.query.updateTable('questions').set({ data: JSON.stringify(row) }).where('id', '=', question.id));
  assert.equal(search('EXTERNAL_UPDATE_NEEDLE').counts.question, 1); assert.match(search('COMMON private note').items[0].title, /EXTERNAL_UPDATE/);
  assert.throws(() => store.transaction(() => { store.put('questions', question.id, { ...row, title: 'ROLLED_BACK_NEEDLE' }); assert.equal(search('ROLLED_BACK_NEEDLE').counts.question, 1); throw new Error('rollback'); }));
  assert.equal(search('ROLLED_BACK_NEEDLE').total, 0); assert.equal(search('EXTERNAL_UPDATE_NEEDLE').counts.question, 1);
  const original = JSON.stringify(store.require('questions', question.id)); search('PRIVATE_REFERENCE_CANARY'); assert.equal(JSON.stringify(store.require('questions', question.id)), original);
});

test('empty search performs no I/O and warm queries never read full records, answers or notes', t => {
  const { store, search } = fixture(t); search('COMMON');
  const all = store.db.all.bind(store.db); let reads = 0;
  store.all = () => { throw new Error('No full-table reads'); }; store.get = () => { throw new Error('No full-record reads'); };
  store.db.run = () => { throw new Error('Warm search must not write'); };
  store.db.all = ((query: any) => { reads++; const rows = all(query); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_REFERENCE_CANARY|REFERENCE_EXPLANATION_CANARY/); return rows; }) as typeof store.db.all;
  assert.equal(search('COMMON').items.length, 7); assert.ok(reads <= 2);
  store.db.all = () => { throw new Error('Empty query must not read'); }; store.db.one = () => { throw new Error('Empty query must not read'); };
  assert.equal(search('   ').total, 0);
});

test('taxonomy metadata is current after category moves and the independent index can be rebuilt', t => {
  const { store, question, search } = fixture(t); search('COMMON');
  store.put('domains', 'second', { id: 'second', name: '第二领域', description: '', sortOrder: 1 });
  store.put('categories', 'category-one', { id: 'category-one', name: '已改分类', domainId: 'second', parentId: null, description: '' });
  assert.deepEqual(search('COMMON-Q').items.find(item => item.type === 'question')!.domainIds, ['second']);
  assert.equal(search('已改分类').counts.category, 1);
  store.db.run(store.db.query.deleteFrom('metadata').where('key', '=', 'search_projection_version'));
  assert.equal(store.db.projections.initialize(), true); store.db.projections.refreshAll(); assert.equal(search('COMMON-Q').counts.question, 1);
  assert.equal(store.require<any>('questions', question.id).title, question.title);
});

test('search input validates page sizes, query length and token bounds while accepting literal syntax', () => {
  for (const input of [{ q: 'a'.repeat(101) }, { q: 'a b c d e f g h i' }, { pageSize: 15 }, { type: 'unknown' }, { sort: 'sql' }, { includeUnpublished: true }, { extra: true }]) assert.throws(() => searchQuerySchema.parse(input));
  assert.equal(searchQuerySchema.parse({ q: '  %_\'  ' }).q, "%_'");
});
