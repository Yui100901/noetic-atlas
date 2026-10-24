import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { SystemSettings } from '../../shared/models/settings.js';

const q = (id: string) => ({ id, title: id, type: 'true_false', stemMarkdown: '事务可以保证原子性吗？', correctAnswers: ['true'], status: 'published', categoryIds: ['base'], tagIds: [] });
async function fixture(t: test.TestContext) {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'missing-settings-test', staticRoot: 'missing-settings-static' });
  t.after(() => app.close());
  json(await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: { schemaVersion: 1, domains: [{ id: 'computer', name: '计算机' }, { id: 'empty-domain', name: '独立领域' }], categories: [{ id: 'base', name: '基础', domainId: 'computer' }], tags: [], questions: [q('Q1'), q('Q2')], documents: [], papers: [{ id: 'P1', title: '第一卷', mode: 'manual', questionIds: ['Q1'] }, { id: 'P2', title: '第二卷', mode: 'manual', questionIds: ['Q2'] }] } } }));
  return app;
}
function json(r: { statusCode: number; json(): any }, expected = 200) { assert.equal(r.statusCode, expected, JSON.stringify(r.json())); return r.json(); }
type App = Awaited<ReturnType<typeof fixture>>;
async function settings(app: App) { return json(await app.inject('/api/settings')) as SystemSettings; }
async function configure(app: App, changes: Partial<SystemSettings>) {
  return json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: { ...await settings(app), ...changes } } })).settings as SystemSettings;
}
async function draft(app: App, paper = 'P1') { return json(await app.inject({ method: 'POST', url: `/api/papers/${paper}/attempts` }), 201); }
async function submit(app: App, attempt: any) { return json(await app.inject({ method: 'POST', url: `/api/attempts/${attempt.id}/submit`, payload: { answers: Object.fromEntries(attempt.questions.map((x: any) => [x.id, { value: 'false' }])) } })); }

test('settings retain current defaults, validate all fields and reject stale writes atomically', async t => {
  const app = await fixture(t), first = await settings(app);
  assert.deepEqual({ ...first, updatedAt: DEFAULT_SETTINGS.updatedAt }, DEFAULT_SETTINGS);
  assert.deepEqual(json(await app.inject('/api/bootstrap')).settings, first);
  const saved = await configure(app, { maxDraftsPerPaper: 5, autosaveDebounceMs: 750 });
  assert.ok(saved.updatedAt > first.updatedAt);
  const stale = await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: first } });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, 'SETTINGS_VERSION_CONFLICT');
  for (const change of [{ maxDraftsPerPaper: 0 }, { maxQuickHistory: -1 }, { maxImageMiB: 21 }, { pointsByType: { true_false: 2 } }, { reviewIntervalsDays: [1, 2, 7] }, { autosaveDebounceMs: 1 }]) {
    assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: { ...saved, ...change } } })).statusCode, 400);
  }
  assert.deepEqual(await settings(app), saved);
});

test('built-in themes validate, round-trip through portable configuration and default old configurations to green', async t => {
  const app = await fixture(t);
  for (const theme of ['dark', 'pink', 'sky', 'mint', 'green'] as const) {
    const saved = await configure(app, { theme });
    assert.equal(saved.theme, theme);
    assert.equal(json(await app.inject('/api/bootstrap')).settings.theme, theme);
    assert.equal(json(await app.inject('/api/settings/export')).system.theme, theme);
  }
  const saved = await settings(app);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: { ...saved, theme: 'unknown-theme' } } })).statusCode, 400);
  assert.deepEqual(await settings(app), saved);
  const exported = json(await app.inject('/api/settings/export'));
  exported.system.theme = 'sky';
  const preview = json(await app.inject({ method: 'POST', url: '/api/settings/import/preview', payload: { data: exported } }));
  assert.deepEqual(preview.systemChanges.find((change: any) => change.key === 'theme'), { key: 'theme', before: 'green', after: 'sky' });
  json(await app.inject({ method: 'POST', url: '/api/settings/import', payload: { data: exported, fingerprint: preview.fingerprint, confirmed: true } }));
  assert.equal((await settings(app)).theme, 'sky');
  delete exported.system.theme;
  const legacy = json(await app.inject({ method: 'POST', url: '/api/settings/import/preview', payload: { data: exported } }));
  json(await app.inject({ method: 'POST', url: '/api/settings/import', payload: { data: exported, fingerprint: legacy.fingerprint, confirmed: true } }));
  assert.equal((await settings(app)).theme, 'green');
});

test('lower retention limits preview exact counts, reconfirm changed counts and preserve study events', async t => {
  const app = await fixture(t);
  await configure(app, { maxDraftsPerPaper: 5, maxQuickDrafts: 5 });
  for (let i = 0; i < 3; i++) await draft(app);
  for (let i = 0; i < 2; i++) await draft(app, 'P2');
  for (let i = 0; i < 3; i++) json(await app.inject({ method: 'POST', url: '/api/quick-practice', payload: { questionId: 'Q1' } }), 201);
  const baseline = json(await app.inject('/api/export'));
  const desired = { ...await settings(app), maxDraftsPerPaper: 1, maxQuickDrafts: 1 };
  const pending = await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: desired } });
  assert.equal(pending.statusCode, 409); assert.deepEqual(pending.json().error.details, { drafts: 5, history: 0, total: 5 });
  assert.equal(json(await app.inject('/api/attempts')).length, 8); assert.equal((await settings(app)).maxDraftsPerPaper, 5);
  await draft(app);
  const changed = await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: desired, confirmedRetention: true, expectedRetention: pending.json().error.details } });
  assert.equal(changed.statusCode, 409); assert.deepEqual(changed.json().error.details, { drafts: 6, history: 0, total: 6 });
  const saved = json(await app.inject({ method: 'PUT', url: '/api/settings', payload: { settings: desired, confirmedRetention: true, expectedRetention: changed.json().error.details } }));
  assert.deepEqual(saved.retention, { drafts: 6, history: 0, total: 6 });
  assert.equal(json(await app.inject('/api/attempts')).length, 3);
  const after = json(await app.inject('/api/export'));
  for (const table of ['study', 'reviews', 'papers', 'questions']) assert.deepEqual(after[table], baseline[table]);
});

test('configured draft and submitted-history limits apply per paper and quick source without erasing study or review events', async t => {
  const app = await fixture(t);
  await configure(app, { maxDraftsPerPaper: 2, maxQuickDrafts: 1, maxHistoryPerPaper: 1, maxQuickHistory: 1 });
  const a = await draft(app), b = await draft(app);
  json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}`, payload: { answers: { Q1: { value: 'true' } } } }));
  const c = await draft(app);
  assert.equal((await app.inject(`/api/attempts/${b.id}`)).statusCode, 404);
  assert.equal(json(await app.inject('/api/papers/P1/drafts')).length, 2);
  await submit(app, a);
  json(await app.inject({ method: 'PUT', url: `/api/attempts/${a.id}/review`, payload: { mastery: { Q1: 2 } } }));
  const before = json(await app.inject('/api/study'));
  await submit(app, c);
  assert.equal((await app.inject(`/api/attempts/${a.id}`)).statusCode, 404);
  assert.equal(json(await app.inject('/api/attempts?paperId=P1&status=submitted')).length, 1);
  await submit(app, await draft(app, 'P2'));
  assert.equal(json(await app.inject('/api/attempts?source=paper&status=submitted')).length, 2);
  const quick1 = json(await app.inject({ method: 'POST', url: '/api/quick-practice', payload: { questionId: 'Q1' } }), 201); await submit(app, quick1);
  const quick2 = json(await app.inject({ method: 'POST', url: '/api/quick-practice', payload: { questionId: 'Q1' } }), 201); await submit(app, quick2);
  assert.equal((await app.inject(`/api/attempts/${quick1.id}`)).statusCode, 404);
  const after = json(await app.inject('/api/study'));
  assert.deepEqual(after.reviews, before.reviews); assert.ok(after.items.find((x: any) => x.questionId === 'Q1').wrongCount >= before.items[0].wrongCount);
  const exported = json(await app.inject('/api/export')), fresh = await buildApp({ databasePath: ':memory:', seedPath: 'missing-settings-restore' }); t.after(() => fresh.close());
  json(await fresh.inject({ method: 'POST', url: '/api/import', payload: { data: exported, mode: 'merge' } }));
  assert.deepEqual(json(await fresh.inject('/api/study')).reviews, before.reviews);
});

test('new paper defaults and review scheduling read settings while saved snapshots remain stable', async t => {
  const app = await fixture(t);
  await configure(app, { randomQuestionCount: 1, reviewIntervalsDays: [0, 4, 10, 30] });
  const unscored = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '缺省随机卷', mode: 'random' } }), 201);
  assert.equal(unscored.questionCount, 1); assert.equal(unscored.scoring.enabled, false);
  await configure(app, { scoringEnabledByDefault: true, randomTotalPoints: 4, objectivePercent: 85, pointsByType: { ...DEFAULT_SETTINGS.pointsByType, true_false: 4 } });
  const scored = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '配置计分', mode: 'random' } }), 201);
  assert.equal(scored.questionCount, 1); assert.equal(scored.scoring.totalPoints, 4); assert.equal(scored.scoring.objectivePercent, 85);
  const manual = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '手动缺省计分', mode: 'manual', questionIds: ['Q1'] } }), 201);
  assert.equal(manual.scoring.totalPoints, 4);
  await configure(app, { pointsByType: { ...DEFAULT_SETTINGS.pointsByType, true_false: 8 } });
  assert.equal(json(await app.inject(`/api/papers/${manual.id}`)).scoring.totalPoints, 4); assert.equal(json(await app.inject(`/api/papers/${unscored.id}`)).scoring.enabled, false);
  const reviewed = json(await app.inject({ method: 'POST', url: '/api/study/Q1/review', payload: { mastery: 2 } }));
  assert.ok(Math.abs(Date.parse(reviewed.nextReviewAt) - Date.now() - 10 * 86400000) < 2000);
  const draftAttempt = await draft(app); await submit(app, draftAttempt);
  json(await app.inject({ method: 'PUT', url: `/api/attempts/${draftAttempt.id}/review`, payload: { mastery: { Q1: 1 } } }));
  const state = json(await app.inject('/api/questions/Q1')).study;
  assert.ok(Math.abs(Date.parse(state.nextReviewAt) - Date.now() - 4 * 86400000) < 2000);
});

test('paper organization validates domains, protects referenced domains and permanent deletion keeps usable attempt snapshots', async t => {
  const app = await fixture(t);
  assert.equal(json(await app.inject('/api/papers/P1')).organization, 'other');
  assert.equal((await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '缺失领域', mode: 'manual', organization: 'domain', questionIds: ['Q1'] } })).statusCode, 400);
  const p = json(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '独立领域专项', mode: 'manual', organization: 'domain', domainId: 'empty-domain', questionIds: ['Q1'] } }), 201);
  assert.equal(json(await app.inject('/api/papers?organization=domain&domainId=empty-domain')).length, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/domains/empty-domain' })).statusCode, 409);
  const d = await draft(app, p.id), a = await draft(app, p.id); await submit(app, a);
  const removed = json(await app.inject({ method: 'DELETE', url: `/api/papers/${p.id}?permanent=true` })); assert.equal(removed.retainedAttempts, 2);
  assert.equal((await app.inject(`/api/papers/${p.id}`)).statusCode, 404);
  json(await app.inject({ method: 'PUT', url: `/api/attempts/${d.id}`, payload: { answers: { Q1: { value: 'true' } } } })); await submit(app, d);
  assert.equal(json(await app.inject(`/api/attempts/${a.id}`)).paperTitle, '独立领域专项');
  const data = json(await app.inject('/api/export')), fresh = await buildApp({ databasePath: ':memory:', seedPath: 'missing-detached-paper' }); t.after(() => fresh.close());
  json(await fresh.inject({ method: 'POST', url: '/api/import', payload: { data, mode: 'merge' } }));
  assert.equal(json(await fresh.inject(`/api/attempts/${d.id}`)).status, 'submitted');
  assert.equal((await fresh.inject(`/api/papers/${p.id}`)).statusCode, 404);
});

test('migration restores preferences into an untouched installation and preserves already configured target preferences', async t => {
  const app = await fixture(t); await configure(app, { maxDraftsPerPaper: 7, randomQuestionCount: 1 });
  const data = json(await app.inject('/api/export'));
  const fresh = await buildApp({ databasePath: ':memory:', seedPath: 'missing-setting-migration' }); t.after(() => fresh.close());
  json(await fresh.inject({ method: 'POST', url: '/api/import', payload: { data, mode: 'merge' } }));
  assert.equal((await settings(fresh)).maxDraftsPerPaper, 7);
  await configure(fresh, { maxDraftsPerPaper: 9 });
  json(await fresh.inject({ method: 'POST', url: '/api/import', payload: { data, mode: 'merge' } })); assert.equal((await settings(fresh)).maxDraftsPerPaper, 9);
  const invalid = structuredClone(data); invalid.settings[0].id = 'other-settings';
  assert.equal((await fresh.inject({ method: 'POST', url: '/api/import', payload: { data: invalid, mode: 'merge' } })).statusCode, 400);
});
