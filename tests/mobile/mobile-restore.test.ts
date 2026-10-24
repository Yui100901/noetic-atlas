import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs, { type Database } from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.ts';
import { learningSeed, fixtureQuestion } from '../fixtures/learning-seed.js';
import type { DurableStorage } from '../../mobile/runtime.ts';
import type { SQLiteRecoveryBackup } from '../../shared/models/sqlite-restore.ts';

function memoryStorage() {
  let durable: Uint8Array | undefined, failSave = false, failBackup = false;
  const backups = new Map<string, Uint8Array>(); let latest: SQLiteRecoveryBackup | undefined;
  const storage: DurableStorage = {
    async load() { return durable?.slice(); },
    async save(bytes) { if (failSave) throw new Error('simulated full storage'); durable = bytes.slice(); },
    async createRecoveryBackup(bytes) { if (failBackup) throw new Error('simulated backup failure'); latest = { id: `recovery-${backups.size}`, byteLength: bytes.length, createdAt: new Date().toISOString() }; backups.set(latest.id, bytes.slice()); return latest; },
    async loadRecoveryBackup(id) { return backups.get(id)!.slice(); },
    async latestRecoveryBackup() { return latest; },
  };
  return { storage, backups, bytes: () => durable!.slice(), external: (bytes: Uint8Array) => { durable = bytes.slice(); }, failSave: (value: boolean) => { failSave = value; }, failBackup: (value: boolean) => { failBackup = value; } };
}

test('Android restores validated SQLite copies atomically with independent recovery, stale-preview and exam guards', async t => {
  const folder = resolve('test-results/native-restore'); await mkdir(folder, { recursive: true });
  await build({ configFile: false, logLevel: 'error', define: { 'process.env': '{}' }, resolve: { alias: nativeAliases }, build: { outDir: folder, emptyOutDir: false, minify: false, lib: { entry: resolve('mobile/runtime.ts'), formats: ['es'], fileName: () => 'runtime.mjs' } } });
  const { createLocalRuntime } = await import(pathToFileURL(resolve(folder, 'runtime.mjs')).href);
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const sourceStorage = memoryStorage(), targetStorage = memoryStorage();
  const sourceSeed = learningSeed();
  sourceSeed.questions.push(fixtureQuestion('RESTORE-GROUP', 'group', { stemMarkdown: '恢复测试公共材料', parts: [
    { id: 'choice', type: 'true_false', title: '恢复判断小题', stemMarkdown: '应独立保存？', answerMarkdown: '', explanationMarkdown: '', options: [], correctAnswers: ['true'], weight: 1 },
    { id: 'explain', type: 'short_answer', title: '恢复主观小题', stemMarkdown: '解释回滚', answerMarkdown: '保留原连接', explanationMarkdown: '', options: [], correctAnswers: [], weight: 1 },
  ] }));
  const source = await createLocalRuntime(sql, sourceSeed, sourceStorage.storage);
  let target = await createLocalRuntime(sql, learningSeed(), targetStorage.storage);
  t.after(async () => { await source.close(); await target.close(); });
  const call = async (runtime: any, url: string, method = 'GET', body?: unknown, status = 200) => { const response = await runtime.fetch(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; };
  const questionId = learningSeed().questions[0]!.id;
  await call(source, `/api/study/${questionId}`, 'PUT', { notes: '来自整库备份', favorite: true });
  const settings = await call(source, '/api/settings');
  await call(source, '/api/settings', 'PUT', { settings: { ...settings, randomQuestionCount: 7, maxQuickHistory: 1 } });
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bZkAAAAASUVORK5CYII=';
  const asset = await call(source, '/api/assets', 'POST', { filename: '恢复附件.png', mimeType: 'image/png', dataBase64: pngBase64 }, 201);
  await call(source, '/api/study/RESTORE-GROUP', 'PUT', { partId: 'choice', notes: `小题独立笔记 ![附件](/api/assets/${asset.id}/content)`, mastery: 1 });
  const quickIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    const attempt = await call(source, '/api/quick-practice', 'POST', { questionId }, 201); quickIds.push(attempt.id);
    await call(source, `/api/attempts/${attempt.id}/submit`, 'POST', { answers: { [questionId]: { value: 'A' } } });
  }
  await call(source, `/api/attempts/${quickIds[0]}`, 'GET', undefined, 404);
  await call(source, '/api/ai/settings', 'PUT', { enabled: true, baseUrl: 'https://api.example.com/v1', model: 'foreign-model', supportsImages: false, sendImages: false, timeoutSeconds: 60, maxTokens: 4096, key: 'foreign-secret-restore-test' });
  const sourceBytes = sourceStorage.bytes();
  const mutate = (fn: (db: Database) => void) => { const db = new sql.Database(sourceBytes); try { fn(db); return db.export(); } finally { db.close(); } };
  const question = learningSeed().questions[0]!;
  const validRun = { id: 'ai-restore-history', kind: 'explain', status: 'completed', createdAt: '2026-10-20T00:00:00.000Z', model: 'foreign-model', result: { explanationMarkdown: '保留分析历史', followUpsMarkdown: '', pitfallsMarkdown: '' }, questionIds: [questionId], warnings: [], _context: { questionVersions: { [questionId]: question.updatedAt }, sourceByItem: {} } };
  const candidate = mutate(db => {
    db.run('INSERT INTO ai_runs(id,data) VALUES (?,?)', [validRun.id, JSON.stringify(validRun)]);
    db.run("UPDATE question_read_model SET data=json_set(data,'$.title','FAKE RESTORE PROJECTION')");
    db.run('CREATE TRIGGER unexpected_restore_trigger AFTER UPDATE ON ai_settings BEGIN DELETE FROM questions; END');
  });
  await call(target, `/api/study/${questionId}`, 'PUT', { notes: '本机原始数据' });
  await call(target, '/api/ai/settings', 'PUT', { enabled: true, baseUrl: 'https://local.example.com/v1', model: 'local-model', supportsImages: false, sendImages: false, timeoutSeconds: 60, maxTokens: 4096, key: 'local-secret-restore-test' });
  const initialTarget = targetStorage.bytes();

  const empty = new sql.Database(); const emptyBytes = empty.export(); empty.close();
  for (const bytes of [new TextEncoder().encode('not a SQLite database'), emptyBytes,
    mutate(db => db.run('DROP TABLE questions')),
    mutate(db => db.run("UPDATE metadata SET value='2' WHERE key='schema_version'")),
    mutate(db => db.run('PRAGMA user_version=2')),
    mutate(db => db.run('UPDATE questions SET data=? WHERE id=?', [JSON.stringify({ ...question, id: 'MISMATCH' }), questionId])),
    mutate(db => db.run('UPDATE questions SET data=? WHERE id=?', [JSON.stringify({ ...question, difficulty: 99 }), questionId])),
    mutate(db => db.run('UPDATE questions SET data=? WHERE id=?', [JSON.stringify({ ...question, tagIds: ['missing-tag'] }), questionId])),
    mutate(db => db.run('UPDATE settings SET data=? WHERE id=?', [JSON.stringify({ ...settings, randomQuestionCount: -1 }), 'system'])),
    mutate(db => db.run('INSERT INTO ai_runs(id,data) VALUES (?,?)', [validRun.id, JSON.stringify({ ...validRun, result: { explanationMarkdown: 9 } })])),
    mutate(db => db.run('INSERT INTO ai_runs(id,data) VALUES (?,?)', [validRun.id, JSON.stringify({ ...validRun, _context: { questionVersions: {}, sourceByItem: {}, partByItem: { 'RESTORE-GROUP::choice': { partId: 'choice', type: 'true_false' } } } })])),
    mutate(db => db.run('UPDATE study_parts SET data=?', [JSON.stringify({ questionId: 'RESTORE-GROUP', partId: 'other-part' })])),
    mutate(db => db.run('UPDATE learning_results SET data=json_set(data,\'$.items\',json(\'[]\'))')),
    mutate(db => db.run('DELETE FROM assets')),
  ]) {
    await assert.rejects(target.previewRestore(bytes, 'invalid.sqlite'));
    assert.deepEqual(targetStorage.bytes(), initialTarget, 'invalid candidate must never touch current disk');
    assert.equal((await call(target, `/api/questions/${questionId}`)).study.notes, '本机原始数据');
  }
  const preview = await target.previewRestore(candidate, 'complete.sqlite');
  assert.equal(preview.sourceHadAiKey, true); assert.equal(preview.counts.ai_runs, 1); assert.equal(preview.counts.learning_results, 2); assert.equal(preview.counts.study_parts, 1); assert.equal(preview.currentCounts.ai_runs, 0); assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(targetStorage.bytes(), initialTarget, 'preview must remain read-only');
  await call(target, `/api/study/${questionId}`, 'PUT', { notes: '预览后编辑' });
  await assert.rejects(target.restore(preview.token), /预览已失效/);
  assert.equal(targetStorage.backups.size, 0, 'stale confirmations fail before any replacement');
  const beforeExternal = targetStorage.bytes(); const diskPreview = await target.previewRestore(candidate, 'complete.sqlite');
  targetStorage.external(initialTarget);
  await assert.rejects(target.restore(diskPreview.token), /预览后发生变化/);
  await assert.rejects(target.previewRestore(candidate, 'complete.sqlite'), /应用外改变/);
  targetStorage.external(beforeExternal);

  const backupFailurePreview = await target.previewRestore(candidate, 'complete.sqlite'); targetStorage.failBackup(true);
  await assert.rejects(target.restore(backupFailurePreview.token), /backup failure/); targetStorage.failBackup(false);
  assert.deepEqual(targetStorage.bytes(), beforeExternal);
  const failedPreview = await target.previewRestore(candidate, 'complete.sqlite'); targetStorage.failSave(true);
  await assert.rejects(target.restore(failedPreview.token), /原数据已保留/); targetStorage.failSave(false);
  assert.deepEqual(targetStorage.bytes(), beforeExternal); assert.equal(targetStorage.backups.size, 1);
  assert.equal((await call(target, `/api/questions/${questionId}`)).study.notes, '预览后编辑');
  assert.equal((await call(target, '/api/ai/settings')).hasKey, true, 'rollback preserves this device credential');
  await call(target, `/api/study/${questionId}`, 'PUT', { notes: '失败后可继续保存' });

  const paper = await call(target, '/api/papers', 'POST', { title: '恢复考试互斥', mode: 'manual', questionIds: [questionId], scoring: { enabled: false } }, 201);
  const examPreview = await target.previewRestore(candidate, 'complete.sqlite');
  const exam = await call(target, `/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 60 }, 201);
  await assert.rejects(target.restore(examPreview.token), /考试进行中/);
  await assert.rejects(target.previewRestore(candidate, 'complete.sqlite'), /考试进行中/);
  await call(target, `/api/attempts/${exam.id}/submit`, 'POST', {});
  const beforeRestore = targetStorage.bytes();
  const finalPreview = await target.previewRestore(candidate, 'complete.sqlite');
  const result = await target.restore(finalPreview.token);
  assert.equal((await call(target, `/api/questions/${questionId}`)).study.notes, '来自整库备份');
  assert.equal((await call(target, '/api/settings')).randomQuestionCount, 7);
  const ai = await call(target, '/api/ai/settings'); assert.equal(ai.enabled, false); assert.equal(ai.hasKey, false); assert.equal(ai.model, 'foreign-model');
  assert.equal((await call(target, '/api/ai/runs'))[0].result.explanationMarkdown, '保留分析历史');
  assert.equal((await call(target, '/api/questions?search=FAKE%20RESTORE%20PROJECTION')).total, 0, 'untrusted cached projections are rebuilt');
  assert.equal((await call(target, `/api/questions/${questionId}`)).title, question.title, 'imported triggers cannot mutate restored entities');
  assert.equal((await call(target, '/api/study')).partItems[0].partId, 'choice');
  assert.equal((await call(target, `/api/assets/${asset.id}/data`)).dataBase64, pngBase64);
  assert.equal((await call(target, '/api/export')).learningResults.length, 2, 'learning evidence survives even after full attempt pruning');
  await call(target, `/api/attempts/${quickIds[0]}`, 'GET', undefined, 404);
  assert.deepEqual(targetStorage.backups.get(result.recoveryBackup.id), beforeRestore);
  const restored = new sql.Database(targetStorage.bytes());
  assert.equal(restored.exec('PRAGMA integrity_check')[0]!.values[0]![0], 'ok');
  restored.close();
  const rawText = new TextDecoder().decode(targetStorage.bytes());
  assert.ok(!rawText.includes('foreign-secret-restore-test')); assert.ok(!rawText.includes('local-secret-restore-test'));
  await call(target, `/api/study/${questionId}`, 'PUT', { notes: '旧页面排队写入' }, 409);
  assert.equal((await call(target, `/api/questions/${questionId}`)).study.notes, '来自整库备份');
  const sharedRecovery = await target.recoveryBackupBytes(result.recoveryBackup.id);
  const recovery = new sql.Database(sharedRecovery);
  assert.equal(JSON.parse(String(recovery.exec("SELECT data FROM study WHERE id='FIXTURE-CHOICE-1'")[0]!.values[0]![0])).notes, '失败后可继续保存');
  recovery.close(); assert.ok(!new TextDecoder().decode(sharedRecovery).includes('local-secret-restore-test'));
  await target.close(); target = await createLocalRuntime(sql, learningSeed(), targetStorage.storage);
  await call(target, `/api/study/${questionId}`, 'PUT', { notes: '重启后的新记录' });
  assert.deepEqual(targetStorage.backups.get(result.recoveryBackup.id), beforeRestore, 'ordinary writes never rotate the independent recovery copy');

  const oldCandidate = mutate(db => { db.run('DROP TABLE study_parts'); db.run('DROP TABLE learning_results'); db.run('DROP TABLE question_banks'); });
  const oldPreview = await target.previewRestore(oldCandidate, 'legacy-v1.sqlite');
  assert.equal(oldPreview.counts.study_parts, 0); assert.equal(oldPreview.counts.learning_results, 1, 'legacy retained history is upgraded into independent learning evidence');
  await target.restore(oldPreview.token);
  await target.close(); target = await createLocalRuntime(sql, learningSeed(), targetStorage.storage);
  assert.equal((await call(target, `/api/questions/${questionId}`)).study.notes, '来自整库备份');
});
