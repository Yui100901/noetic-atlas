import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { catalog, groups, aliases } from '../../scripts/qa/catalog.mjs';
import {
  parseOptions,
  selectChecks,
  assertAllowed,
  runSuite,
} from '../../scripts/qa/helpers/suite-runner.mjs';
import {
  browserConfiguration,
  fixtureReadyTimeout,
  waitForQaReady,
} from '../../scripts/qa/helpers/browser-runtime.mjs';

const root = resolve(import.meta.dirname, '../..');
const select = (args: string[]) => {
  const options = parseOptions(args);
  return { options, entries: selectChecks(catalog, groups, aliases, options) };
};

test('QA defaults match the six explicit CI smoke checks and deduplicate groups and repeated selections', () => {
  const first = select([]).entries;
  assert.equal(first.length, 6);
  assert.ok(first.every((entry: any) => entry.groups.includes('smoke')));
  assert.deepEqual(select(['--group', 'smoke', '--only', first[0].id]).entries, first);
  assert.deepEqual(
    select(['--only', 'maintenance-ui,maintenance-ui']).entries.map((entry: any) => entry.id),
    ['maintenance-ui'],
  );
});

test('QA broad runs cannot silently call a real provider, inspect working data, release artifacts or a device', () => {
  const { entries, options } = select(['--all', '--allow-live-ai', '--allow-operator-data']);
  assert.ok(entries.length > 80);
  assert.ok(
    entries.every(
      (entry: any) =>
        !entry.access &&
        !entry.directArgs &&
        !entry.groups.some((group: string) =>
          ['release', 'android', 'local-source'].includes(group),
        ),
    ),
  );
  assert.doesNotThrow(() => assertAllowed(entries, options));
  const ai = select(['--group', 'live-ai']);
  assert.throws(() => assertAllowed(ai.entries, ai.options), /allow-live-ai/);
  assert.ok(!select(['--allow-live-ai']).entries.some((entry: any) => entry.access));
  const content = select(['--group', 'content-audit']);
  assert.throws(() => assertAllowed(content.entries, content.options), /allow-operator-data/);
  const explicit = select(['--group', 'live-ai', '--allow-live-ai']);
  assert.doesNotThrow(() => assertAllowed(explicit.entries, explicit.options));
  assert.deepEqual(
    select(['--group', 'android']).entries.map((entry: any) => entry.id),
    ['android-functional', 'android-layout'],
  );
  const local = select(['--only', 'real-pdf-books']);
  assert.throws(() => assertAllowed(local.entries, local.options), /--books-root/);
});

test('QA rejects misspelled groups, IDs and flags instead of falling back to a default run', () => {
  for (const args of [['--grop', 'smoke'], ['--group'], ['--only', '--all'], ['--group', ',']])
    assert.throws(() => parseOptions(args));
  assert.throws(() => select(['--group', 'unknown']), /未知检查组/);
  assert.throws(() => select(['--only', 'unknown']), /未知检查项/);
});

test('QA inventory covers every check entry, has unique safe IDs and known groups', async () => {
  const ids = catalog.map((entry: any) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  const files = new Set(catalog.map((entry: any) => basename(entry.script)));
  for (const alias of Object.keys(aliases)) files.add(`check-${alias}.mjs`);
  const checks = (await readdir(join(root, 'scripts/qa'))).filter((file) =>
    /^check-.*\.(?:ts|mjs)$/.test(file),
  );
  assert.deepEqual(
    checks.filter((file) => !files.has(file)),
    [],
  );
  for (const entry of catalog) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(
      entry.groups.length && entry.groups.every((group: string) => Object.hasOwn(groups, group)),
    );
    assert.ok(entry.timeoutMs >= 1000);
    assert.ok(entry.script.startsWith('scripts/qa/'));
  }
});

test('QA browser options respect a local tool override and use bundled Chromium on non-Windows hosts', () => {
  assert.deepEqual(browserConfiguration({}, 'linux').launch, { headless: true });
  assert.deepEqual(browserConfiguration({}, 'win32').launch, { headless: true, channel: 'msedge' });
  assert.deepEqual(browserConfiguration({ PLAYWRIGHT_CHANNEL: 'chromium' }, 'win32').launch, {
    headless: true,
  });
  assert.equal(
    browserConfiguration(
      { PLAYWRIGHT_MODULE: 'tools/playwright/index.mjs', PLAYWRIGHT_CHANNEL: 'chrome' },
      'linux',
    ).module.startsWith('file:'),
    true,
  );
  assert.equal(fixtureReadyTimeout({}), 120000);
  assert.equal(fixtureReadyTimeout({ QA_FIXTURE_READY_TIMEOUT_MS: '30000' }), 30000);
  for (const value of ['0', 'NaN', '300001', '2.5'])
    assert.throws(() => fixtureReadyTimeout({ QA_FIXTURE_READY_TIMEOUT_MS: value }));
});

test('QA readiness distinguishes real readiness, early process death and preparation timeout', async () => {
  const child = { exitCode: null, signalCode: null };
  assert.deepEqual(
    await waitForQaReady(child, {
      prefix: 'READY ',
      stdout: () => 'ignored\nREADY {"origin":"local"}\n',
      stderr: () => '',
      timeoutMs: 75,
    }),
    { origin: 'local' },
  );
  await assert.rejects(
    waitForQaReady(
      { ...child, exitCode: 7 },
      { prefix: 'READY ', stdout: () => '', stderr: () => 'fixture failed', timeoutMs: 75 },
    ),
    /exited.*fixture failed/,
  );
  await assert.rejects(
    waitForQaReady(child, { prefix: 'READY ', stdout: () => '', stderr: () => '', timeoutMs: 75 }),
    /timed out/,
  );
});

async function fixture(t: test.TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-qa-runner-'));
  t.after(async () => {
    assert.equal(dirname(folder), tmpdir());
    assert.ok(basename(folder).startsWith('atlas-qa-runner-'));
    await rm(folder, { recursive: true, force: true });
  });
  return folder;
}

test('QA records real subprocess success, failure and timeout, retains logs and continues after a failed check', async (t) => {
  const folder = await fixture(t);
  const scripts = {
    pass: 'console.log("fixture passed");',
    fail: 'console.error("fixture failed");process.exitCode=7;',
    hang: 'setInterval(()=>{},1000);',
  };
  for (const [id, source] of Object.entries(scripts))
    await writeFile(join(folder, `${id}.cjs`), source);
  const entries = ['fail', 'hang', 'pass'].map((id) => ({
    id,
    script: join(folder, `${id}.cjs`),
    timeoutMs: id === 'hang' ? 150 : 10_000,
  }));
  const report = await runSuite(entries, { root, directory: folder });
  assert.equal(report.ok, false);
  assert.equal(report.serial, true);
  assert.deepEqual(
    report.results.map((result: any) => result.status),
    ['failed', 'timed_out', 'passed'],
  );
  assert.equal(report.results[0].exitCode, 7);
  assert.deepEqual(report.notRun, []);
  assert.match(await readFile(join(folder, 'fail.log'), 'utf8'), /fixture failed/);
  assert.match(await readFile(join(folder, 'pass.log'), 'utf8'), /fixture passed/);
  assert.deepEqual(JSON.parse(await readFile(join(folder, 'report.json'), 'utf8')), report);
});

test('optional source audits skip without spawning when input is absent and execute when complete', async (t) => {
  const folder = await fixture(t),
    executed: string[] = [];
  const entries = [
    { id: 'specific-files', optionalInputs: { files: ['packs/first.json', 'packs/second.json'] } },
    {
      id: 'common-packs',
      optionalInputs: { directory: 'packs', suffix: '-common.json', minimum: 2 },
    },
  ];
  const execute = async (entry: { id: string }) => {
    executed.push(entry.id);
    return { id: entry.id, status: 'passed' };
  };
  const absent = await runSuite(entries, {
    root: folder,
    directory: join(folder, 'absent-report'),
    execute,
  });
  assert.equal(absent.ok, true);
  assert.equal(absent.summary.skipped, 2);
  assert.equal(absent.summary.passed, 0);
  assert.deepEqual(executed, []);
  assert.ok(
    absent.results.every((result: any) => /缺少可选公开内容包.*未执行/.test(result.reason)),
  );
  await mkdir(join(folder, 'packs'));
  await Promise.all(
    ['first.json', 'second.json', 'one-common.json', 'two-common.json'].map((name) =>
      writeFile(join(folder, 'packs', name), '{}'),
    ),
  );
  const supplied = await runSuite(entries, {
    root: folder,
    directory: join(folder, 'present-report'),
    execute,
  });
  assert.equal(supplied.summary.skipped, 0);
  assert.equal(supplied.summary.passed, 2);
  assert.deepEqual(executed, ['specific-files', 'common-packs']);
  assert.deepEqual(
    supplied.plan.map((item: any) => item.optionalInputs),
    entries.map((entry) => entry.optionalInputs),
  );
});

test('QA cancellation prevents unstarted checks from running and marks the report incomplete', async (t) => {
  const folder = await fixture(t),
    controller = new AbortController(),
    executed: string[] = [];
  const report = await runSuite([{ id: 'first' }, { id: 'later' }], {
    root,
    directory: folder,
    signal: controller.signal,
    execute: async (entry: any) => {
      executed.push(entry.id);
      controller.abort();
      return { id: entry.id, status: 'cancelled' };
    },
  });
  assert.deepEqual(executed, ['first']);
  assert.deepEqual(report.notRun, ['later']);
  assert.equal(report.ok, false);
  assert.equal(report.cancelled, true);
});
