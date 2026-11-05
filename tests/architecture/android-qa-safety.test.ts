import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../../server/index.js';
import { seedAndroidLayout } from '../../scripts/testing/android/layout-fixture.mjs';
import { connectAndroid } from '../../scripts/testing/android/device.mjs';

test('Android layout seed exercises the real API with isolated content and valid reader/attempt identities', async (t) => {
  const external = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Layout fixtures must not contact an external service');
  });
  const app = await buildApp({
    databasePath: ':memory:',
    seedPath: 'missing-android-layout-seed',
    staticRoot: 'missing-android-layout-web',
    native: true,
    dailyPushScheduler: false,
  });
  t.after(() => app.close());
  const api = async (url: string, method: any = 'GET', payload?: unknown) => {
    const response = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.ok(
      response.statusCode < 400,
      `${method} ${url}: ${response.statusCode} ${response.body}`,
    );
    return response.json();
  };
  const before = await api('/api/bootstrap');
  assert.equal(before.stats.totalQuestions, 0);
  const state = await seedAndroidLayout(api);
  const all = await api('/api/questions?status=all&page=1&pageSize=100');
  assert.equal(all.total, 18);
  assert.equal(all.items.filter((q: any) => q.status === 'published').length, 17);
  assert.equal(all.items.filter((q: any) => q.status === 'pending').length, 1);
  const group = await api('/api/questions/ANDROID-LAYOUT-GROUP');
  assert.equal(group.parts.length, 2);
  assert.deepEqual(
    group.parts.map((part: any) => part.type),
    ['single_choice', 'fill_blank'],
  );
  const paper = await api('/api/papers/' + state.paperId);
  assert.equal(paper.questionIds.length, 17);
  const draft = await api('/api/attempts/' + state.draftId),
    submitted = await api('/api/attempts/' + state.submittedId);
  assert.equal(draft.status, 'in_progress');
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.paperId, paper.id);
  assert.notEqual(draft.id, submitted.id);
  assert.ok(
    Object.values(submitted.answers).length > 0,
    'Submitted layout must contain actual answers',
  );
  const source = await api('/api/questions/ANDROID-LAYOUT-0');
  assert.equal(source.study.favorite, true);
  assert.ok(source.study.notes);
  const document = await api('/api/documents/' + state.documentId);
  assert.equal(document.title, '移动端资料编辑与原文阅读测试');
  const focus = await api('/api/focus-sessions/' + state.focusId);
  assert.equal(focus.paperId, paper.id);
  const feedback = await api('/api/question-feedback?questionId=ANDROID-LAYOUT-0&status=all');
  assert.equal(feedback.total, 1);
  const ai = await api('/api/ai/settings');
  assert.equal(ai.enabled, false);
  assert.equal(ai.hasKey, false);
  const after = await api('/api/bootstrap');
  assert.equal(after.stats.totalQuestions, 17);
  assert.equal(after.stats.favoriteCount, 1);
  assert.ok(after.stats.wrongCount >= 15);
  assert.equal((await api('/api/questions/ANDROID-LAYOUT-1')).study.wrongCount, 1);
  assert.equal(after.stats.totalDocuments, 1);
  assert.equal(external.mock.callCount(), 0);
});

test('Android CLI help and argument errors finish before any device or toolchain access', () => {
  const root = resolve(import.meta.dirname, '../..');
  const invalid = resolve(tmpdir(), 'noetic-qa-nonexistent-toolchain');
  for (const script of [
    'scripts/qa/check-android-layout.mjs',
    'scripts/testing/android/build-qa.mjs',
  ]) {
    const run = (argument: string) =>
      spawnSync(process.execPath, [script, argument], {
        cwd: root,
        env: {
          ...process.env,
          ANDROID_ADB: invalid,
          JAVA_HOME: invalid,
          ANDROID_HOME: invalid,
          ANDROID_SDK_ROOT: invalid,
          ANDROID_SERIAL: '',
        },
        encoding: 'utf8',
        timeout: 45000,
        windowsHide: true,
      });
    const help = run('--help');
    assert.equal(help.error, undefined);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /QA APK|qa\.apk/);
    const unknown = run('--unknown-option');
    assert.equal(unknown.error, undefined);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /ERR_PARSE_ARGS_UNKNOWN_OPTION/);
    assert.doesNotMatch(
      help.stderr + unknown.stderr,
      /ENOENT|需要 Java|Install the separate|Specify --serial/,
    );
  }
});

test('device helper refuses an unspecified serial before filesystem or ADB work', async () => {
  await assert.rejects(connectAndroid({ serial: '' }), /Specify --serial or ANDROID_SERIAL/);
});
