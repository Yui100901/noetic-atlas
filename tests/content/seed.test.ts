import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildApp } from '../../server/index.js';
import { Store } from '../../server/core/store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { createEmptyInitialData } from '../../shared/models/initial-data.js';
import { learningSeed } from '../fixtures/learning-seed.js';

function json(response: { statusCode: number; json(): any }) { assert.equal(response.statusCode, 200, JSON.stringify(response.json())); return response.json(); }
async function directory(t: test.TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-empty-install-'));
  t.after(async () => { assert.equal(dirname(resolve(folder)), resolve(tmpdir())); assert.ok(folder.includes('atlas-empty-install-')); await rm(folder, { recursive: true, force: true }); });
  return folder;
}

test('default application starts empty with usable preferences and ignores an unrequested working-directory seed', async t => {
  const folder = await directory(t), initial = createEmptyInitialData();
  for (const key of ['domains', 'categories', 'tags', 'questions', 'questionBanks', 'documents', 'papers'] as const) assert.deepEqual(initial[key], []);
  await mkdir(join(folder, 'data')); await writeFile(join(folder, 'data/seed.json'), JSON.stringify(learningSeed()));
  const previousDirectory = process.cwd(), previousSeed = process.env.SEED_PATH;
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    process.chdir(folder); delete process.env.SEED_PATH;
    app = await buildApp({ databasePath: ':memory:', staticRoot: join(folder, 'no-web') });
  } finally {
    process.chdir(previousDirectory);
    if (previousSeed === undefined) delete process.env.SEED_PATH; else process.env.SEED_PATH = previousSeed;
  }
  t.after(() => app.close());
  const bootstrap = json(await app.inject('/api/bootstrap'));
  for (const key of ['totalQuestions', 'totalPapers', 'totalDocuments', 'personalQuestions', 'generalQuestions', 'favoriteCount']) assert.equal(bootstrap.stats[key], 0, key);
  assert.deepEqual(bootstrap.domains, []); assert.deepEqual(bootstrap.categories, []); assert.deepEqual(bootstrap.tags, []);
  assert.deepEqual({ ...bootstrap.settings, updatedAt: DEFAULT_SETTINGS.updatedAt }, DEFAULT_SETTINGS);
  assert.equal(json(await app.inject('/api/ai/settings')).enabled, false);
  assert.equal(json(await app.inject('/api/ai/settings')).hasKey, false);
  assert.equal(json(await app.inject('/api/questions')).total, 0);
  const exported = json(await app.inject('/api/export'));
  for (const key of ['questions', 'questionBanks', 'documents', 'papers', 'study', 'attempts']) assert.deepEqual(exported[key], []);
  const added = json(await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: learningSeed() } }));
  assert.ok(added); assert.equal(json(await app.inject('/api/bootstrap')).stats.totalQuestions, 6, 'an empty installation supports explicit data import');
});

test('explicit operator seed retains published, pending and personal distinctions and cannot overwrite an installed library', async t => {
  const folder = await directory(t), path = join(folder, 'explicit-seed.json'), databasePath = join(folder, 'installed.sqlite'), seed = learningSeed({ includeNonPublic: true });
  await writeFile(path, JSON.stringify(seed));
  let app = await buildApp({ databasePath, seedPath: path, staticRoot: join(folder, 'no-web') });
  try {
    const published = seed.questions.filter(q => q.status === 'published');
    assert.equal(json(await app.inject('/api/bootstrap')).stats.totalQuestions, published.length);
    assert.equal(json(await app.inject('/api/questions?collection=personal')).total, 1);
    assert.equal(json(await app.inject('/api/questions?status=pending')).total, 1);
    const question = seed.questions[0]!;
    json(await app.inject({ method: 'PUT', url: `/api/study/${question.id}`, payload: { favorite: true, notes: 'restart must preserve this note' } }));
    const settings = json(await app.inject('/api/settings'));
    json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: { ...settings, randomQuestionCount: 2 } } }));
    await app.close();
    const replacement = learningSeed(); replacement.questions = [replacement.questions[0]!]; replacement.questionBanks = [];
    await writeFile(path, JSON.stringify(replacement));
    app = await buildApp({ databasePath, seedPath: path, staticRoot: join(folder, 'no-web') });
    assert.equal(json(await app.inject('/api/questions?status=all')).total, seed.questions.length);
    assert.equal(json(await app.inject('/api/settings')).randomQuestionCount, 2);
    assert.equal(json(await app.inject(`/api/questions/${question.id}`)).study.notes, 'restart must preserve this note');
    assert.equal(json(await app.inject('/api/questions/FIXTURE-PENDING')).status, 'pending');
  } finally { await app.close(); }
});

test('explicit initialization marker prevents reseeding even when the entire content collection is deliberately emptied', async t => {
  const folder = await directory(t), seedPath = join(folder, 'explicit.json'), databasePath = join(folder, 'empty-again.sqlite');
  await writeFile(seedPath, JSON.stringify(learningSeed()));
  let app = await buildApp({ databasePath, seedPath, staticRoot: join(folder, 'no-web') }); await app.close();
  const store = new Store(databasePath);
  try {
    store.transaction(() => { for (const table of ['questions', 'question_banks', 'domains', 'categories', 'tags'] as const) for (const record of store.all(table)) store.remove(table, record.id); });
    assert.ok(store.database.one(store.database.query.selectFrom('metadata').select('value').where('key', '=', 'seed_initialized')));
  } finally { store.db.close(); }
  app = await buildApp({ databasePath, seedPath, staticRoot: join(folder, 'no-web') });
  try { assert.equal(json(await app.inject('/api/bootstrap')).stats.totalQuestions, 0); assert.deepEqual(json(await app.inject('/api/taxonomy')).domains, []); }
  finally { await app.close(); }
});
