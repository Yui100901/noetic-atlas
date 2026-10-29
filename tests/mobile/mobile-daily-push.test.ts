import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('mobile daily pushing uses durable serialized writes, catches up only today, and preserves disabled legacy upgrades', async t => {
  const folder = resolve('test-results/native-daily-push'); await mkdir(folder, { recursive: true });

  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const questions = Array.from({ length: 68 }, (_, index) => ({ id: `MOBILE-DAILY-${index}`, title: `移动每日题${index}`, type: index < 60 ? 'true_false' : 'multiple_choice', stemMarkdown: `隔离测试命题${index}`, answerMarkdown: index < 60 ? '正确' : '两项均正确', explanationMarkdown: '本题仅供临时测试。', correctAnswers: index < 60 ? ['true'] : ['A', 'B'], options: index < 60 ? [] : [{ key: 'A', text: '正确选项一' }, { key: 'B', text: '正确选项二' }, { key: 'C', text: '错误选项' }], categoryIds: ['mobile-daily-category'], status: 'published' }));
  const seed = { schemaVersion: 1, domains: [{ id: 'mobile-daily-domain', name: '手机每日范围', description: '', sortOrder: 0 }], categories: [{ id: 'mobile-daily-category', domainId: 'mobile-daily-domain', parentId: null, name: '基础分类', description: '', sortOrder: 0 }], tags: [], questions, documents: [], papers: [] };
  let durable: Uint8Array | undefined, failSave = false, saves = 0;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { if (failSave) throw new Error('test disk full'); durable = bytes.slice(); saves++; } };
  let clock = new Date('2026-10-24T15:58:00Z');
  const options = { dailyPushNow: () => new Date(clock) };
  let runtime = await createLocalRuntime(sql, seed, storage, options); t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', data?: unknown, expected = 200): Promise<any> => {
    const response = await runtime.fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const initial = await api('/api/settings'); assert.equal(initial.pointsByType.multiple_choice, 4); assert.equal(initial.dailyPush.enabled, false);
  assert.equal(initial.reviewScheduling.strategy, 'fsrs');
  // The historical learned-pool contract remains available in fixed mode.
  await api('/api/settings', 'PUT', { settings: { ...initial, reviewScheduling: { ...initial.reviewScheduling, strategy: 'fixed' } } });
  assert.equal((await api('/api/daily-push')).today, null);
  for (let index = 0; index < 6; index++) await api(`/api/study/MOBILE-DAILY-${index}`, 'PUT', { mastery: 1 });
  await api('/api/study/MOBILE-DAILY-7', 'PUT', { notes: '只有笔记不算已学', favorite: true });
  const beforeEnable = durable!.slice();
  await api('/api/settings', 'PUT', { settings: { ...await api('/api/settings'), dailyPush: { ...initial.dailyPush, enabled: true, domainId: 'mobile-daily-domain', categoryIds: ['mobile-daily-category'] } } });
  await api('/api/daily-push/check', 'POST');
  const first = (await api('/api/daily-push')).today;
  assert.equal(first.dateKey, '2026-10-24'); assert.equal(first.reviewPoints, 6); assert.equal(first.transferredPoints, 24); assert.equal(first.targetNewPoints, 44); assert.ok(first.totalPoints >= 50);
  assert.equal(new Set(first.questionIds).size, first.questionIds.length); assert.ok(!first.reviewQuestionIds.includes('MOBILE-DAILY-7'));
  const paper = await api(`/api/papers/${first.paperId}`); assert.equal(paper.scoring.totalPoints, first.totalPoints); assert.equal(paper.scoring.pointsByType.multiple_choice, 4);
  const draft = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  const answers = Object.fromEntries(draft.questions.map((question: any) => [question.id, { value: questions.find(source => source.id === question.id)!.correctAnswers }]));
  const submitted = await api(`/api/attempts/${draft.id}/submit`, 'POST', { answers }); assert.equal(submitted.objectiveScore, first.totalPoints);
  await api(`/api/daily-push/${first.id}/read`, 'POST');
  const beforeNoop = saves; failSave = true;
  const duplicate = await api('/api/daily-push/check', 'POST'); assert.equal(duplicate.generated, false); assert.equal(saves, beforeNoop, 'no-op daily checks do not export or save the large database');
  failSave = false;

  await runtime.close(); clock = new Date('2026-10-24T16:01:00Z');
  runtime = await createLocalRuntime(sql, seed, storage, options);
  const second = await api('/api/daily-push'); assert.equal(second.today.dateKey, '2026-10-25'); assert.equal(second.recent.length, 2);
  assert.equal(second.recent.find((record: any) => record.id === first.id).readAt !== null, true);
  assert.equal((await api(`/api/attempts/${draft.id}`)).objectiveScore, first.totalPoints);
  const stable = durable!.slice(); await runtime.close(); clock = new Date('2026-10-25T16:01:00Z'); failSave = true;
  runtime = await createLocalRuntime(sql, seed, storage, options);
  assert.equal((await api('/api/daily-push')).today, null); assert.equal((await api('/api/daily-push')).recent.length, 2); assert.deepEqual(durable, stable, 'failed startup generation rolls back papers and notifications together');
  failSave = false;
  const retried = await api('/api/daily-push/check', 'POST'); assert.equal(retried.generated, true); assert.equal(retried.record.dateKey, '2026-10-26');
  assert.equal((await api('/api/daily-push')).recent.length, 3);
  await api('/api/settings', 'PUT', { settings: { ...await api('/api/settings'), dailyPush: { ...(await api('/api/settings')).dailyPush, enabled: false } } });
  await runtime.close(); clock = new Date('2026-10-27T16:01:00Z'); runtime = await createLocalRuntime(sql, seed, storage, options);
  assert.equal((await api('/api/daily-push')).today, null); assert.equal((await api('/api/daily-push')).recent.length, 3, 'disabled dates do not backfill missed history');

  // A disabled installed database missing the new table is upgraded durably,
  // without opening a second full DB in application runtime code.
  await runtime.close();
  const legacyPath = resolve(folder, 'legacy-disabled.sqlite'); await writeFile(legacyPath, beforeEnable);
  const legacy = new DatabaseSync(legacyPath); legacy.exec('DROP TABLE daily_pushes');
  const raw = JSON.parse(String(legacy.prepare("SELECT data FROM settings WHERE id='system'").get()!.data)); delete raw.dailyPush;
  legacy.prepare("UPDATE settings SET data=? WHERE id='system'").run(JSON.stringify(raw)); legacy.close();
  durable = new Uint8Array(await readFile(legacyPath)); const beforeUpgrade = saves;
  runtime = await createLocalRuntime(sql, seed, storage, options); assert.ok(saves > beforeUpgrade, 'new table schema is persisted even with daily pushing disabled');
  assert.equal((await api('/api/daily-push')).config.enabled, false); assert.equal((await api('/api/daily-push')).today, null);
  assert.equal((await api('/api/questions/MOBILE-DAILY-7')).study.notes, '只有笔记不算已学');
  const restoredPath = resolve(folder, 'upgraded-disabled.sqlite'); await writeFile(restoredPath, durable!);
  const upgraded = new DatabaseSync(restoredPath); assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_pushes'").get()); assert.equal(upgraded.prepare('SELECT count(*) AS count FROM daily_pushes').get()!.count, 0); upgraded.close();
});
