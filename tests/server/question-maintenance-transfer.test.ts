import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../server/core/store.js';
import type { Question } from '../../shared/models/types.js';
import type { QuestionDraft, QuestionRevision } from '../../shared/models/question-maintenance.js';
import { fixtureQuestion } from '../fixtures/learning-seed.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { createAsset, deleteAsset, listAssets } from '../../server/modules/assets/service.js';
import {
  cleanupPlan,
  cleanupSelectionSchema,
  executeCleanup,
} from '../../server/modules/maintenance/cleanup.js';
import { dataHealth } from '../../server/modules/maintenance/health.js';
import { exportShare } from '../../server/modules/sharing/routes.js';

const old = '2020-01-01T00:00:00.000Z';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const otherPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  const question: Question = fixtureQuestion('MAINTENANCE-Q', 'short_answer', {
    categoryIds: [],
    tagIds: [],
    sourceRefs: [],
  });
  store.put('questions', question.id, question);
  const {
    id: _id,
    status: _status,
    createdAt: _created,
    updatedAt: _updated,
    ...content
  } = question;
  const draft: QuestionDraft = {
    id: 'maintenance-draft',
    questionId: question.id,
    baseUpdatedAt: question.updatedAt!,
    state: {
      form: { ...structuredClone(content), title: '', stemMarkdown: '', status: 'published' },
      sources: '尚未完成的来源文本 |',
      reason: '尚未提交',
    },
    createdAt: old,
    updatedAt: old,
  };
  const revision: QuestionRevision = {
    id: 'maintenance-revision',
    questionId: question.id,
    sequence: 1,
    content: structuredClone(content),
    origin: 'manual',
    reason: '历史编辑原因',
    changedFields: ['answerMarkdown'],
    createdAt: old,
    sourceUpdatedAt: old,
  };
  return { store, question, draft, revision };
}

test('complete JSON retains incomplete editing drafts and historical taxonomy without adding private maintenance records to shares', (t) => {
  const { store, draft, revision, question } = fixture(t);
  draft.state.form.categoryIds = ['removed-category'];
  revision.content.tagIds = ['removed-tag'];
  store.put('question_drafts', draft.id, draft);
  store.put('question_revisions', revision.id, revision);
  const backup = exportData(store);
  assert.deepEqual(backup.questionDrafts, [draft]);
  assert.deepEqual(backup.questionRevisions, [revision]);
  const target = new Store(':memory:');
  t.after(() => target.database.close());
  importData(target, backup);
  assert.deepEqual(target.require('question_drafts', draft.id), draft);
  assert.deepEqual(target.require('question_revisions', revision.id), revision);
  target.put('question_drafts', draft.id, {
    ...draft,
    state: { ...draft.state, sources: '本地未保存的来源' },
  });
  target.put('question_revisions', revision.id, { ...revision, reason: '本地修订说明' });
  importData(target, backup);
  assert.equal(
    target.require<QuestionDraft>('question_drafts', draft.id).state.sources,
    '本地未保存的来源',
  );
  assert.equal(
    target.require<QuestionRevision>('question_revisions', revision.id).reason,
    '本地修订说明',
  );
  const share = exportShare(store, { kind: 'questions', ids: [question.id] });
  assert.equal(Object.hasOwn(share, 'questionDrafts'), false);
  assert.equal(Object.hasOwn(share, 'questionRevisions'), false);
  assert.ok(!JSON.stringify(share).includes('历史编辑原因'));
});

test('invalid identities and duplicate revision sequences reject the entire backup merge', (t) => {
  const { store, draft, revision } = fixture(t);
  store.put('question_drafts', draft.id, draft);
  store.put('question_revisions', revision.id, revision);
  const original = exportData(store);
  for (const mutate of [
    (data: any) => {
      data.questionDrafts[0].state.form.id = 'spoofed-id';
    },
    (data: any) => {
      data.questionDrafts[0].questionId = 'missing-source';
    },
    (data: any) => {
      data.questionRevisions[0].content.title = '';
    },
    (data: any) => {
      data.questionRevisions.push({ ...data.questionRevisions[0], id: 'same-sequence-other-id' });
    },
  ]) {
    const target = new Store(':memory:');
    try {
      const data = structuredClone(original);
      mutate(data);
      assert.throws(() => importData(target, data));
      assert.deepEqual(target.all('questions'), []);
      assert.deepEqual(target.all('question_drafts'), []);
      assert.deepEqual(target.all('question_revisions'), []);
    } finally {
      target.database.close();
    }
  }
  const existing = new Store(':memory:');
  try {
    existing.put('questions', revision.questionId, store.require('questions', revision.questionId));
    existing.put('question_revisions', 'local-other-history', {
      ...revision,
      id: 'local-other-history',
    });
    assert.throws(() => importData(existing, original), /相同编号的不同修订/);
    assert.deepEqual(existing.all('question_drafts'), []);
    assert.equal(existing.all('question_revisions').length, 1);
  } finally {
    existing.database.close();
  }
});

test('draft and revision attachments remain protected until explicit draft cleanup or revision removal', (t) => {
  const { store, draft, revision } = fixture(t);
  const draftAsset = createAsset(store, {
    filename: 'draft.png',
    mimeType: 'image/png',
    dataBase64: png,
  });
  const revisionAsset = createAsset(store, {
    filename: 'revision.png',
    mimeType: 'image/png',
    dataBase64: png,
  });
  draft.state.form.title = '草稿附件测试';
  draft.state.form.stemMarkdown = '';
  draft.state.sources = `仅在来源文本中的参考 | /api/assets/${draftAsset.id}/content`;
  revision.content.answerMarkdown = `![历史图片](/api/assets/${revisionAsset.id}/content)`;
  store.put('question_drafts', draft.id, draft);
  store.put('question_revisions', revision.id, revision);
  assert.throws(() => deleteAsset(store, draftAsset.id), /仍被/);
  assert.throws(() => deleteAsset(store, revisionAsset.id), /仍被/);
  assert.ok((listAssets(store, {}) as any[]).every((asset) => asset.referenced));
  assert.equal(dataHealth(store).unusedAssets, 0);
  const selection = { kinds: ['question_drafts'] as const, olderThanDays: 30 };
  const plan = cleanupPlan(store, { ...selection, kinds: [...selection.kinds] });
  assert.equal(plan.preview.total, 1);
  assert.equal(plan.preview.items[0].samples[0].title, '草稿附件测试');
  executeCleanup(store, { ...selection, kinds: [...selection.kinds] }, plan.preview.fingerprint);
  assert.equal(store.all('question_drafts').length, 0);
  assert.equal(store.all('question_revisions').length, 1);
  assert.equal(
    cleanupSelectionSchema.safeParse({ kinds: ['question_revisions'], olderThanDays: 30 }).success,
    false,
  );
  deleteAsset(store, draftAsset.id);
  assert.throws(() => deleteAsset(store, revisionAsset.id), /仍被/);
  store.remove('question_revisions', revision.id);
  deleteAsset(store, revisionAsset.id);
});

test('missing or same-ID different attachment bytes cannot silently corrupt imported maintenance content', (t) => {
  const { store, draft } = fixture(t);
  const asset = createAsset(store, {
    filename: 'source.png',
    mimeType: 'image/png',
    dataBase64: png,
  });
  draft.state.form.stemMarkdown = `![草稿](/api/assets/${asset.id}/content)`;
  store.put('question_drafts', draft.id, draft);
  const original = exportData(store);
  const target = new Store(':memory:');
  t.after(() => target.database.close());
  const other = createAsset(target, {
    filename: 'local.png',
    mimeType: 'image/png',
    dataBase64: otherPng,
  });
  target.put('assets', asset.id, { ...target.require<any>('assets', other.id), id: asset.id });
  assert.throws(() => importData(target, original), /附件ID与本机不同文件冲突/);
  assert.equal(target.all('questions').length, 0);
  const empty = new Store(':memory:');
  t.after(() => empty.database.close());
  assert.throws(() => importData(empty, { ...original, assets: [] }), /本地文件不存在/);
  assert.equal(empty.all('questions').length, 0);
});

test('a read-only repair baseline may retain missing attachments without making repaired content backups unrestorable', (t) => {
  const { store, revision, question } = fixture(t);
  const preserved = createAsset(store, {
    filename: 'baseline.png',
    mimeType: 'image/png',
    dataBase64: png,
  });
  const baseline: QuestionRevision = {
    ...revision,
    origin: 'baseline',
    content: {
      ...revision.content,
      answerMarkdown: `损坏原题证据 ![](/api/assets/missing-baseline/content)\n仍存在的文件 ![](/api/assets/${preserved.id}/content)`,
    },
  };
  store.put('question_revisions', baseline.id, baseline);
  assert.throws(() => deleteAsset(store, preserved.id), /仍被/);
  const exported = exportData(store);
  const target = new Store(':memory:');
  t.after(() => target.database.close());
  importData(target, exported);
  assert.deepEqual(target.require('question_revisions', baseline.id), baseline);
  assert.equal(
    target.require<Question>('questions', question.id).answerMarkdown,
    question.answerMarkdown,
  );
  assert.throws(() => deleteAsset(target, preserved.id), /仍被/);
  const invalid = structuredClone(exported);
  invalid.questionRevisions[0].origin = 'manual';
  const rejected = new Store(':memory:');
  t.after(() => rejected.database.close());
  assert.throws(() => importData(rejected, invalid), /本地文件不存在/);
  assert.deepEqual(rejected.all('questions'), []);
});
