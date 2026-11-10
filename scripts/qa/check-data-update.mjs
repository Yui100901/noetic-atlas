/** Replace the program tree while retaining the complete sibling data folder.
 * Uses disposable data and two same-source builds labelled 1.0 / 1.0.1. This
 * tests update plumbing, not a hypothetical future schema or final EXE/APK. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { seedUpdateData, assertUpdateData } from './helpers/update-fixture.mjs';
import { businessSnapshot } from './helpers/update-snapshot.mjs';
import { listenOnLoopback } from '../../server/http/loopback.ts';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const { preparePaths, launchServer } = require('../../desktop/runtime.cjs');
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'atlas-data-update-')));
const output = resolve(root, 'test-results/data-update');
await mkdir(output, { recursive: true });
const report = {
  passed: false,
  syntheticOnly: true,
  sameSourcePatchSimulation: true,
  baselineVersion: '1.0',
  updateVersion: '1.0.1',
  channels: [],
  scope:
    'Web service and Windows desktop service; final packaged EXE/APK is a separate acceptance.',
};
const inside = (parent, path) => {
  const part = relative(parent, path);
  return (
    !isAbsolute(part) &&
    part !== '..' &&
    !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
  );
};
assert.equal(inside(root, temporary), false);
assert.ok(existsSync(join(root, 'dist/server/main.js')), 'Build the current program first');
let active;

async function prepareProgram(folder, channel, version) {
  const serverRoot = channel === 'desktop' ? join(folder, 'resources/server') : folder;
  await mkdir(serverRoot, { recursive: true });
  await cp(join(root, 'dist'), join(serverRoot, 'dist'), {
    recursive: true,
    filter: (path) => relative(join(root, 'dist'), path).split(/[\\/]/)[0] !== 'mobile',
  });
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(serverRoot, 'package.json'), JSON.stringify({ ...metadata, version }));
  await writeFile(join(serverRoot, 'dist/package.json'), JSON.stringify({ ...metadata, version }));
  const configurationRoot = channel === 'desktop' ? folder : serverRoot;
  await mkdir(join(configurationRoot, 'config'), { recursive: true });
  await cp(join(root, 'config/defaults.json'), join(configurationRoot, 'config/defaults.json'));
  await symlink(
    join(root, 'node_modules'),
    join(serverRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  if (channel === 'desktop') {
    await cp(join(root, 'desktop'), join(serverRoot, 'desktop'), { recursive: true });
    const nodeRoot = join(folder, 'resources/node');
    await mkdir(nodeRoot, { recursive: true });
    const cached = join(root, '.localtools/desktop-cache/node-v24.22.0-win-x64/node.exe');
    assert.ok(
      existsSync(cached),
      'Prepare the Windows official Node runtime using windows:release',
    );
    await cp(cached, join(nodeRoot, 'node.exe'));
  }
}
async function stop() {
  if (active) {
    const current = active;
    active = undefined;
    await current.close();
  }
}
async function start(folder, channel) {
  if (channel === 'desktop') {
    const paths = preparePaths({
      portableRoot: folder,
      resourcesPath: join(folder, 'resources'),
      env: {},
    });
    active = await launchServer(paths);
    return active.origin;
  }
  // Use an ephemeral port without taking over the operator's 4317 service.
  const { createServer } = await import('node:net');
  const listener = createServer();
  await listenOnLoopback(
    (port) =>
      new Promise((done, reject) => {
        const failed = (error) => reject(error);
        listener.once('error', failed);
        listener.listen(port, '127.0.0.1', () => {
          listener.off('error', failed);
          done();
        });
      }),
  );
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    DATABASE_PATH: join(folder, 'data/noetic-atlas.sqlite'),
  };
  delete env.SEED_PATH;
  const child = spawn(process.execPath, ['dist/server/main.js'], {
    cwd: folder,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '',
    spawnError;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (value) => {
    log = (log + value).slice(-3000);
  });
  child.stderr.on('data', (value) => {
    log = (log + value).slice(-3000);
  });
  active = {
    close: async () => {
      if (child.exitCode !== null) return;
      await new Promise((done) => {
        const force = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('exit', () => {
          clearTimeout(force);
          done();
        });
        child.kill('SIGTERM');
      });
    },
  };
  const origin = 'http://127.0.0.1:' + port;
  for (let index = 0; index < 150; index++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw Error('Isolated service exited: ' + log);
    try {
      if ((await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) })).ok)
        return origin;
    } catch {}
    await delay(150);
  }
  throw Error('Isolated service startup timeout');
}
function apiAt(origin) {
  return async (path, method = 'GET', body) => {
    const response = await fetch(origin + path, {
      method,
      signal: AbortSignal.timeout(20000),
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.ok(response.ok, path + ': ' + response.status + ' ' + JSON.stringify(result));
    return result;
  };
}
try {
  for (const channel of process.platform === 'win32' ? ['web', 'desktop'] : ['web']) {
    const base = join(temporary, channel, '1.0'),
      update = join(temporary, channel, '1.0.1');
    await prepareProgram(base, channel, '1.0');
    await prepareProgram(update, channel, '1.0.1');
    const baselineApi = apiAt(await start(base, channel));
    assert.equal((await baselineApi('/api/openapi.json')).info.version, '1.0');
    const state = await seedUpdateData(baselineApi);
    await assertUpdateData(baselineApi, state);
    await stop();
    const originalDatabase = join(base, 'data/noetic-atlas.sqlite');
    const before = businessSnapshot(originalDatabase);
    for (const table of [
      'questions',
      'papers',
      'attempts',
      'study',
      'review_cards',
      'review_events',
      'document_versions',
      'assets',
      'question_drafts',
      'document_drafts',
      'question_revisions',
      'focus_sessions',
      'learning_days',
      'ai_settings',
    ])
      assert.ok(before[table]?.count > 0, channel + ': fixture missing ' + table);
    const backup = join(temporary, channel, 'before-update');
    await writeFile(join(base, 'data/keep-user-file.txt'), 'user-owned-sidecar');
    await cp(join(base, 'data'), backup, { recursive: true });
    assert.ok(inside(temporary, resolve(base)) && inside(temporary, resolve(update)));
    assert.notEqual(resolve(base), temporary);
    await rename(join(base, 'data'), join(update, 'data'));
    await rm(base, { recursive: true, force: true });
    let api = apiAt(await start(update, channel));
    assert.equal((await api('/api/openapi.json')).info.version, '1.0.1');
    await assertUpdateData(api, state);
    await stop();
    assert.deepEqual(
      businessSnapshot(join(update, 'data/noetic-atlas.sqlite')),
      before,
      channel + ': first update changed retained business rows',
    );
    assert.equal(
      await readFile(join(update, 'data/keep-user-file.txt'), 'utf8'),
      'user-owned-sidecar',
    );
    api = apiAt(await start(update, channel));
    await api('/api/study/' + state.questionId, 'PUT', {
      favorite: true,
      notes: '补丁更新后新增的笔记。',
    });
    await stop();
    api = apiAt(await start(update, channel));
    assert.equal(
      (await api('/api/questions/' + state.questionId)).study.notes,
      '补丁更新后新增的笔记。',
    );
    await stop();
    const rollback = join(temporary, channel, 'rollback-1.0');
    await prepareProgram(rollback, channel, '1.0');
    await cp(backup, join(rollback, 'data'), { recursive: true });
    api = apiAt(await start(rollback, channel));
    assert.equal((await api('/api/openapi.json')).info.version, '1.0');
    await assertUpdateData(api, state);
    await stop();
    assert.deepEqual(
      businessSnapshot(join(rollback, 'data/noetic-atlas.sqlite')),
      before,
      channel + ': restoring pre-update backup changed retained data',
    );
    assert.equal(
      await readFile(join(rollback, 'data/keep-user-file.txt'), 'utf8'),
      'user-owned-sidecar',
    );
    report.channels.push({
      channel,
      passed: true,
      before,
      programReplaced: true,
      oldProgramRemoved: true,
      retainedWholeDataFolder: true,
      postUpdateWriteSurvivesRestart: true,
      preUpdateBackupRollback: true,
    });
    console.log(JSON.stringify({ channel, passed: true }));
  }
  report.passed = true;
} finally {
  await stop();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const target = resolve(temporary);
  assert.equal(dirname(target), await realpath(tmpdir()));
  assert.ok(basename(target).startsWith('atlas-data-update-'));
  await rm(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
