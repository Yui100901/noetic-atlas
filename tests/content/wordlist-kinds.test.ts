import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';
import type { StoredPaper } from '../../server/modules/practice/service.js';
import { planGeneratedWordlistKinds, enableGeneratedWordlistKinds } from '../../scripts/content/vocabulary/enable-wordlist-papers.js';
import { wordlistPapers } from '../../scripts/content/manage.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const q = questionSchema.parse({ id: 'EN-V-000001', title: 'abandon', type: 'short_answer', stemMarkdown: 'abandon', answerMarkdown: '放弃', explanationMarkdown: '释义', status: 'published', vocabulary: { language: 'en', headword: 'abandon', meaningPrompt: '放弃；遗弃', acceptedAnswers: ['abandon'], pronunciations: [{ label: '美式', ipa: '/əˈbændən/', sourceLabel: 'source', sourceUrl: 'https://example.org/ipa', license: 'MIT', method: 'source' }] } }) as Question;
  store.put('questions', q.id!, q);
  const { vocabulary: _, ...oldSnapshot } = q;
  const paper: StoredPaper = { id: 'wordlist-english-001', title: '英语单词表 001', description: '原说明', mode: 'manual', questionIds: [q.id!], questionCount: 1, filters: null, archived: true, version: 1, createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z', snapshot: [oldSnapshot] };
  store.put('papers', paper.id, paper); return { store, paper, q };
}
test('generated wordlists opt in without changing snapshots, archive or old attempts; repeating is idempotent', t => {
  const { store, paper, q } = fixture(t);
  assert.equal(planGeneratedWordlistKinds(store).updates.length, 1);
  assert.equal(store.require<StoredPaper>('papers', paper.id).practiceKind, undefined, 'preview is read-only');
  assert.equal(enableGeneratedWordlistKinds(store).updated, 1);
  const updated = store.require<StoredPaper>('papers', paper.id);
  assert.equal(updated.practiceKind, 'vocabulary'); assert.equal(updated.version, 2); assert.equal(updated.archived, true);
  assert.deepEqual(updated.snapshot, paper.snapshot); assert.deepEqual(store.require('questions', q.id!), q);
  assert.equal(updated.createdAt, paper.createdAt); assert.notEqual(updated.updatedAt, paper.updatedAt);
  assert.equal(enableGeneratedWordlistKinds(store).unchanged, 1);
});
test('mixed or changed wordlist sources are skipped instead of guessing; public generation requires structured safe cards', t => {
  const { store, paper, q } = fixture(t);
  store.put('questions', q.id!, { ...q, title: 'a different word' });
  assert.equal(enableGeneratedWordlistKinds(store).skipped.length, 1);
  assert.deepEqual(store.require('papers', paper.id), paper);
  store.put('papers', paper.id, { ...paper, snapshot: [{ ...q, id: 'PLAIN' }], questionIds: ['PLAIN'] });
  assert.equal(enableGeneratedWordlistKinds(store).skipped.length, 1);
  const pack = { domains: [{ id: 'english' }], questions: [q] };
  assert.equal(wordlistPapers(pack)[0]!.practiceKind, 'vocabulary');
  assert.equal(wordlistPapers({ ...pack, questions: [{ ...q, vocabulary: undefined }] })[0]!.practiceKind, 'standard');
});
