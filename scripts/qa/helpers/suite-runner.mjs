/** Selection and serial execution only; individual checks own their fixtures. */
import { spawn, execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { resolve, relative } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const values = (value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
export function parseOptions(args) {
  const options = {
    groups: [],
    ids: [],
    list: false,
    dryRun: false,
    all: false,
    allowLiveAi: false,
    allowOperatorData: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--group', '--only'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || !values(value).length) throw Error(`${arg}需要值`);
      options[arg === '--group' ? 'groups' : 'ids'].push(...values(value));
    } else {
      const flag = {
        '--list': 'list',
        '--dry-run': 'dryRun',
        '--all': 'all',
        '--allow-live-ai': 'allowLiveAi',
        '--allow-operator-data': 'allowOperatorData',
        '--help': 'help',
      }[arg];
      if (!flag) throw Error(`未知参数：${arg}`);
      options[flag] = true;
    }
  }
  return options;
}

export function selectChecks(catalog, groups, aliases, options) {
  for (const group of options.groups)
    if (!Object.hasOwn(groups, group)) throw Error(`未知检查组：${group}`);
  const ids = options.ids.map((id) => aliases[id] || id);
  for (const id of ids)
    if (!catalog.some((entry) => entry.id === id)) throw Error(`未知检查项：${id}`);
  const selectedGroups =
    options.groups.length || ids.length || options.all ? options.groups : ['smoke'];
  // Broad offline runs never silently include real AI, operator data, release
  // artifacts or a device, even when a permission flag is present.
  return catalog.filter(
    (entry) =>
      ids.includes(entry.id) ||
      entry.groups.some((group) => selectedGroups.includes(group)) ||
      (options.all &&
        entry.groups.some((group) => ['static', 'browser', 'performance'].includes(group))),
  );
}

export function assertAllowed(checks, options) {
  if (checks.some((entry) => entry.access === 'live-ai') && !options.allowLiveAi)
    throw Error('真实AI检查会读取现有配置并请求供应商；请显式添加 --allow-live-ai');
  if (checks.some((entry) => entry.access === 'operator-data') && !options.allowOperatorData)
    throw Error('内容操作核对会读取工作数据库；请显式添加 --allow-operator-data');
}

/** Kill only the spawned check and its descendants. Each check still has its
 * own graceful cleanup; this is a final bound for a hung process or browser. */
async function terminate(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await execute('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
    }).catch(() => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

export async function executeCheck(entry, { root, directory, env = process.env, signal }) {
  const logPath = resolve(directory, `${entry.id}.log`);
  const log = createWriteStream(logPath);
  let logError;
  log.on('error', (error) => {
    logError = error;
  });
  const child = spawn(process.execPath, ['--import', 'tsx', entry.script, ...(entry.args || [])], {
    cwd: root,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false,
    spawnError,
    cancelled = !!signal?.aborted;
  child.stdout.on('data', (chunk) => log.write(chunk));
  child.stderr.on('data', (chunk) => log.write(chunk));
  child.once('error', (error) => {
    spawnError = error;
  });
  const abort = () => {
    cancelled = true;
    void terminate(child);
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate(child);
  }, entry.timeoutMs);
  const started = performance.now();
  const exit = await new Promise((done) => {
    child.once('close', (code, exitSignal) => done({ code, signal: exitSignal }));
    if (cancelled) void terminate(child);
  });
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);
  log.end();
  await finished(log).catch((error) => {
    logError = error;
  });
  return {
    id: entry.id,
    status: cancelled
      ? 'cancelled'
      : timedOut
        ? 'timed_out'
        : exit.code === 0 && !spawnError && !logError
          ? 'passed'
          : 'failed',
    durationMs: Math.round(performance.now() - started),
    exitCode: exit.code,
    signal: exit.signal,
    log: relative(root, logPath).replaceAll('\\', '/'),
    ...(spawnError || logError ? { error: (spawnError || logError).message } : {}),
  };
}

/** Optional source packs are absent from a clean software checkout. Only
 * ENOENT/ENOTDIR mean "not provided"; permission and other IO failures stay
 * real failures instead of silently skipping a supplied, broken fixture. */
export async function missingOptionalInputs(entry, root) {
  const input = entry.optionalInputs;
  if (!input) return;
  const missing = [];
  for (const file of input.files || []) {
    try {
      await access(resolve(root, file));
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      missing.push(file);
    }
  }
  if (input.directory) {
    let files = [];
    try {
      files = await readdir(resolve(root, input.directory), { withFileTypes: true });
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    const count = files.filter(
      (file) => file.isFile() && file.name.endsWith(input.suffix || ''),
    ).length;
    if (count < input.minimum)
      missing.push(
        `${input.directory}/*${input.suffix || ''}：需要至少${input.minimum}份，现有${count}份`,
      );
  }
  return missing.length ? `缺少可选公开内容包；未执行内容核验：${missing.join('；')}` : undefined;
}

export async function runSuite(
  checks,
  { root, directory, env, signal, execute = executeCheck, onProgress = () => {} },
) {
  await mkdir(directory, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    serial: true,
    nodeVersion: process.versions.node,
    platform: process.platform,
    selected: checks.map((entry) => entry.id),
    plan: checks.map((entry) => ({
      id: entry.id,
      script: entry.script || null,
      args: entry.args || [],
      timeoutMs: entry.timeoutMs || null,
      ...(entry.optionalInputs ? { optionalInputs: entry.optionalInputs } : {}),
    })),
    results: [],
  };
  const save = () =>
    writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  for (const entry of checks) {
    if (signal?.aborted) break;
    let result;
    try {
      const missing = await missingOptionalInputs(entry, root);
      if (missing) result = { id: entry.id, status: 'skipped', reason: missing };
      else if (entry.platform && entry.platform !== process.platform)
        result = { id: entry.id, status: 'skipped', reason: `requires ${entry.platform}` };
      else result = await execute(entry, { root, directory, env, signal });
    } catch (error) {
      result = { id: entry.id, status: 'failed', error: String(error.message || error) };
    }
    report.results.push(result);
    await save();
    onProgress(result);
  }
  report.finishedAt = new Date().toISOString();
  report.cancelled = !!signal?.aborted;
  report.notRun = checks
    .filter((entry) => !report.results.some((result) => result.id === entry.id))
    .map((entry) => entry.id);
  report.summary = Object.fromEntries(
    ['passed', 'failed', 'timed_out', 'skipped', 'cancelled'].map((status) => [
      status,
      report.results.filter((result) => result.status === status).length,
    ]),
  );
  report.ok =
    !report.cancelled &&
    report.notRun.length === 0 &&
    !report.summary.failed &&
    !report.summary.timed_out &&
    !report.summary.cancelled;
  await save();
  return report;
}
