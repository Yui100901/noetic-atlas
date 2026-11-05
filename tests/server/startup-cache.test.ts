import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../server/core/store.js';
import { dashboardStats } from '../../server/core/read-models.js';
import { questionSchema } from '../../server/core/validation.js';
import { buildApp } from '../../server/index.js';

const question = (id: string) =>
  questionSchema.parse({
    id,
    title: id,
    type: 'short_answer',
    stemMarkdown: '说明事务原子性。',
    answerMarkdown: '全部提交或全部回滚。',
    status: 'published',
  });
function file(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-startup-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'synthetic.sqlite');
}
const options = (databasePath: string) => ({
  databasePath,
  seedPath: 'missing-startup-cache-seed',
  staticRoot: 'missing-startup-cache-web',
  dailyPushScheduler: false,
});

test('content aggregates follow local writes and never expose a mutable cached object', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.put('questions', 'one', question('one'));
  const first = dashboardStats(store);
  assert.equal(first.totalQuestions, 1);
  first.typeCounts.short_answer = 999;
  first.domainQuestionCounts.bad = { published: 999, pending: 0 };
  assert.deepEqual(dashboardStats(store).typeCounts, { short_answer: 1 });
  assert.deepEqual(dashboardStats(store).domainQuestionCounts, {});
  store.put('questions', 'two', question('two'));
  assert.equal(dashboardStats(store).totalQuestions, 2);
  store.remove('questions', 'one');
  assert.equal(dashboardStats(store).totalQuestions, 1);
});

test('nested rollback invalidates aggregates computed inside the abandoned transaction', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.put('questions', 'one', question('one'));
  assert.equal(dashboardStats(store).totalQuestions, 1);
  assert.throws(() =>
    store.transaction(() => {
      store.put('questions', 'two', question('two'));
      assert.equal(dashboardStats(store).totalQuestions, 2);
      assert.throws(() =>
        store.transaction(() => {
          store.put('questions', 'three', question('three'));
          assert.equal(dashboardStats(store).totalQuestions, 3);
          throw Error('inner rollback');
        }),
      );
      assert.equal(dashboardStats(store).totalQuestions, 2);
      throw Error('outer rollback');
    }),
  );
  assert.equal(dashboardStats(store).totalQuestions, 1);
});

test('a commit from a second connection invalidates previously cached domain counts', (t) => {
  const path = file(t),
    store = new Store(path),
    external = new Store(path);
  try {
    assert.equal(dashboardStats(store).totalQuestions, 0);
    external.put('domains', 'a', { id: 'a', name: 'A' });
    external.put('domains', 'b', { id: 'b', name: 'B' });
    external.put('categories', 'category', {
      id: 'category',
      domainId: 'a',
      name: '分类',
      parentId: null,
    });
    external.put('questions', 'one', { ...question('one'), categoryIds: ['category'] });
    assert.deepEqual(dashboardStats(store).domainQuestionCounts, {
      a: { published: 1, pending: 0 },
    });
    external.put('categories', 'category', {
      id: 'category',
      domainId: 'b',
      name: '分类',
      parentId: null,
    });
    assert.deepEqual(dashboardStats(store).domainQuestionCounts, {
      b: { published: 1, pending: 0 },
    });
    external.put('questions', 'one', {
      ...question('one'),
      status: 'archived',
      categoryIds: ['category'],
    });
    assert.equal(dashboardStats(store).totalQuestions, 0);
  } finally {
    external.db.close();
    store.db.close();
  }
});

test('review deadlines advance without writes while content aggregates remain cached', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.put('questions', 'one', question('one'));
  const due = Date.parse('2035-01-01T00:00:00Z');
  store.put('study', 'one', {
    questionId: 'one',
    favorite: true,
    wrongCount: 1,
    nextReviewAt: new Date(due).toISOString(),
  });
  const original = Date.now;
  try {
    Date.now = () => due - 1;
    assert.equal(dashboardStats(store).dueCount, 0);
    const version = store.database.readVersion();
    Date.now = () => due + 1;
    assert.equal(dashboardStats(store).dueCount, 1);
    assert.equal(store.database.readVersion(), version);
  } finally {
    Date.now = original;
  }
});

test('clean startup avoids full source reads and redundant taxonomy validation', async (t) => {
  const path = file(t),
    seed = new Store(path);
  seed.put('questions', 'one', question('one'));
  seed.db.close();
  const first = await buildApp(options(path));
  await first.close();
  const all = Store.prototype.all,
    validate = Store.prototype.validateTaxonomyReferences;
  Store.prototype.all = function (table) {
    assert.notEqual(table, 'questions', 'clean startup must not decode every question');
    return all.call(this, table);
  };
  Store.prototype.validateTaxonomyReferences = function () {
    throw Error('clean startup repeated taxonomy scan');
  };
  try {
    const reopened = await buildApp(options(path));
    await reopened.close();
  } finally {
    Store.prototype.all = all;
    Store.prototype.validateTaxonomyReferences = validate;
  }
});

test('projection refresh cannot consume pending validation, and failed startup remains retryable', async (t) => {
  const path = file(t),
    first = await buildApp(options(path));
  await first.close();
  const external = new Store(path);
  external.put('questions', 'bad', { ...question('bad'), categoryIds: ['missing'] });
  external.database.projections.refreshAll();
  external.db.close();
  await assert.rejects(buildApp(options(path)), { code: 'INVALID_REFERENCE' });
  await assert.rejects(buildApp(options(path)), { code: 'INVALID_REFERENCE' });
  const repaired = new Store(path);
  repaired.remove('questions', 'bad');
  repaired.db.close();
  const reopened = await buildApp(options(path));
  try {
    assert.equal((await reopened.inject('/api/bootstrap')).json().stats.totalQuestions, 0);
  } finally {
    await reopened.close();
  }
});

test('changing an asset revalidates unchanged owners and catches a broken image MIME type', async (t) => {
  const path = file(t),
    seed = new Store(path);
  seed.put('assets', 'image', { id: 'image', mimeType: 'image/png' });
  seed.put('questions', 'one', {
    ...question('one'),
    stemMarkdown: '查看图片 ![示意图](/api/assets/image/content)',
  });
  seed.db.close();
  const first = await buildApp(options(path));
  await first.close();
  const external = new Store(path);
  external.put('assets', 'image', { id: 'image', mimeType: 'application/pdf' });
  external.db.close();
  await assert.rejects(buildApp(options(path)), { code: 'ASSET_NOT_IMAGE' });
});
