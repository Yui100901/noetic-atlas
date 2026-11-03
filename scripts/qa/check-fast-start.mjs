/** Verify launcher behavior on an empty temporary database and ephemeral port. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { buildState } from '../build/start-cache.mjs';
import { stopChild } from './helpers/browser-harness.mjs';

const root = resolve(import.meta.dirname, '../..'),
  folder = await mkdtemp(join(tmpdir(), 'atlas-fast-start-')),
  execute = promisify(execFile);
let child;
try {
  const state = buildState(root);
  assert.equal(state.fresh, true, 'run npm run build immediately before this smoke test');
  const reserved = createServer();
  await new Promise((done) => reserved.listen(0, '127.0.0.1', done));
  const port = reserved.address().port;
  await new Promise((done) => reserved.close(done));
  const env = {
    ...process.env,
    DATABASE_PATH: join(folder, 'empty.sqlite'),
    SEED_PATH: join(folder, 'no-seed.json'),
    HOST: '127.0.0.1',
    PORT: String(port),
  };
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const { stdout } = await execute(process.execPath, ['scripts/start.mjs', '--plan'], {
      cwd: root,
      env,
    });
    const plan = JSON.parse(stdout.trim());
    assert.equal(plan.needsBuild, false);
    samples.push(plan.checkMs);
  }
  const { stdout: forced } = await execute(
    process.execPath,
    ['scripts/start.mjs', '--build', '--plan'],
    { cwd: root, env },
  );
  assert.equal(JSON.parse(forced).needsBuild, true);
  const started = performance.now();
  let log = '',
    errors = '';
  child = spawn(process.execPath, ['scripts/start.mjs', '--fast'], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => (log += data));
  child.stderr.on('data', (data) => (errors += data));
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(log + errors);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(40);
  }
  assert.ok(ready, 'temporary service did not become ready: ' + log + errors);
  const readyMs = Math.round(performance.now() - started);
  assert.ok(!log.includes('正在构建'), 'fast path must not invoke compilers');
  const { stdout: reused } = await execute(process.execPath, ['scripts/start.mjs', '--fast'], {
    cwd: root,
    env,
  });
  assert.ok(
    reused.includes('已有学习站运行'),
    'repeated start must not create another process or rebuild',
  );
  let cmdCheckMs, cmdDirectMs;
  if (process.platform === 'win32') {
    const at = performance.now();
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/start.ps1', '--plan'],
      { cwd: root, env },
    );
    assert.match(stdout, /"needsBuild":false/);
    cmdCheckMs = Math.round(performance.now() - at);
    const cmdAt = performance.now();
    const direct = await execute('cmd.exe', ['/d', '/c', '启动学习站.cmd', '--plan'], {
      cwd: root,
      env,
    });
    assert.match(direct.stdout, /"needsBuild":false/);
    cmdDirectMs = Math.round(performance.now() - cmdAt);
  }
  const report = {
    inputCheckMs: samples,
    fastReadyMs: readyMs,
    powershellPlanMs: cmdCheckMs,
    cmdPlanMs: cmdDirectMs,
    checks: [
      'unchanged auto mode skips build',
      'forced build selects rebuild',
      'fast mode starts a temporary empty database',
      'second start reuses identified service',
      'PowerShell forwards plan option',
    ],
    database: 'temporary-empty',
    operatorServiceAccessed: false,
  };
  const output = resolve(root, 'test-results/fast-start');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (process.platform === 'win32' && child?.pid && child.exitCode === null) {
    await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
  }
  await stopChild(child);
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  assert.ok(basename(folder).startsWith('atlas-fast-start-'));
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
