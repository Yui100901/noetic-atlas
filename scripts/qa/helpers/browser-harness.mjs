/** Isolated browser QA: no fixed ports, existing services or operator data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const projectRoot = resolve(import.meta.dirname, '../../..');
const readyPrefix = 'NOETIC_BROWSER_QA_READY ';

export async function stopChild(child, timeoutMs = 3000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  if (
    await Promise.race([
      stopped.then(() => true),
      delay(timeoutMs, undefined, { ref: false }).then(() => false),
    ])
  )
    return;
  child.kill('SIGKILL');
  await Promise.race([stopped, delay(timeoutMs, undefined, { ref: false })]);
}

/** setup is trusted fixture code evaluated after buildApp. It may return small
 * IDs for the browser; it must not read local configuration or real AI keys.
 * The helper always owns a fresh :memory: DB and a loopback ephemeral port. */
export async function startBrowserHarness({
  name,
  setup = '',
  viewport = { width: 1440, height: 1000 },
  reducedMotion = 'reduce',
  onDialog = (dialog) => void dialog.accept(),
  allowedOrigins = [],
  timeoutMs = 30_000,
} = {}) {
  assert.match(name || '', /^[a-z0-9][a-z0-9-]*$/);
  const folder = resolve(projectRoot, 'test-results', name);
  const childPath = relative(resolve(projectRoot, 'test-results'), folder);
  assert.ok(childPath && !childPath.startsWith('..') && !isAbsolute(childPath));
  await mkdir(folder, { recursive: true });
  const fixture = `import assert from 'node:assert/strict';import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:${JSON.stringify(resolve(folder, 'no-implicit-seed'))},staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const state=await(async()=>{${setup}\n})();
console.log(${JSON.stringify(readyPrefix)}+JSON.stringify({...state,origin:await app.listen({host:'127.0.0.1',port:0})}));`;
  const server = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', fixture],
    { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '',
    spawnError,
    browser,
    page,
    closed = false;
  server.stdout.on('data', (value) => {
    stdout = (stdout + value).slice(-1_048_576);
  });
  server.stderr.on('data', (value) => {
    stderr = (stderr + value).slice(-1_048_576);
  });
  server.once('error', (error) => {
    spawnError = error;
  });
  const errors = [],
    external = [];
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await browser?.close();
    } finally {
      await stopChild(server);
    }
  };
  const captureFailure = async (error, details = {}) => {
    await page
      ?.screenshot({ path: resolve(folder, 'failure.png'), fullPage: true })
      .catch(() => {});
    await writeFile(
      resolve(folder, 'failure.json'),
      JSON.stringify(
        {
          ...details,
          error: String(error?.stack || error),
          errors,
          external,
          stderr,
          serverExit: server.exitCode,
          url: page?.url(),
        },
        null,
        2,
      ),
    );
  };
  try {
    let state;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null || server.signalCode !== null)
        throw new Error(
          `Fixture stopped before readiness (${server.exitCode ?? server.signalCode}): ${stderr}`,
        );
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith(readyPrefix));
      if (line) {
        state = JSON.parse(line.slice(readyPrefix.length));
        break;
      }
      await delay(50);
    }
    assert.ok(state, `Fixture readiness timed out: ${stderr}`);
    const address = new URL(state.origin);
    assert.equal(address.hostname, '127.0.0.1');
    assert.notEqual(address.port, '4317', 'QA cannot attach to the operator service');
    const { chromium } = await import(
      process.env.PLAYWRIGHT_MODULE
        ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href
        : 'playwright'
    );
    const channel =
      process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium');
    browser = await chromium.launch({
      headless: true,
      ...(channel === 'chromium' ? {} : { channel }),
    });
    page = await browser.newPage({
      viewport,
      locale: 'zh-CN',
      reducedMotion,
      serviceWorkers: 'block',
    });
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', onDialog);
    const origins = new Set([state.origin, ...allowedOrigins]);
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (origins.has(url.origin) || ['data:', 'blob:'].includes(url.protocol))
        return route.continue();
      external.push(url.href);
      return route.abort();
    });
    return {
      root: projectRoot,
      folder,
      state,
      origin: state.origin,
      browser,
      page,
      errors,
      external,
      captureFailure,
      close,
      assertClean() {
        assert.deepEqual(errors, [], 'Unexpected browser errors');
        assert.deepEqual(external, [], 'Unexpected external requests');
      },
    };
  } catch (error) {
    await captureFailure(error);
    await close();
    throw error;
  }
}
