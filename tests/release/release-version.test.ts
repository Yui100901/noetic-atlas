import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
// @ts-expect-error Release helpers deliberately use plain JavaScript.
import {
  normalizeReleaseVersion,
  androidVersionCode,
  expectedReleaseArtifacts,
  selectReleaseVersion,
  syncReleaseVersion,
} from '../../scripts/release/version.mjs';
// @ts-expect-error Release helpers deliberately use plain JavaScript.
import { parseReleaseArgs, createReleasePlan, executeRelease } from '../../scripts/release.mjs';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-release-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg =
    '{\r\n\t"name": "noetic-atlas",\r\n\t"version": "1.5.0",\r\n\t"scripts": {"version": "never invoke a hook"},\r\n\t"custom": "保留原格式"\r\n}\r\n';
  const lock =
    '{\n "name": "noetic-atlas", "version": "1.5.0", "lockfileVersion": 3,\n "packages": {"": {"name": "noetic-atlas", "version": "1.5.0", "private": true}, "node_modules/example": {"version": "1.5.0", "integrity": "preserve"}}\n}\n';
  await writeFile(join(root, 'package.json'), pkg);
  await writeFile(join(root, 'package-lock.json'), lock);
  const current = async () =>
    Promise.all(
      ['package.json', 'package-lock.json'].map((name) => readFile(join(root, name), 'utf8')),
    );
  return { root, pkg, lock, current };
}

test('versions normalize an optional v prefix and reject unsafe or unsupported input', () => {
  for (const [value, expected] of [
    ['v1.5.1', '1.5.1'],
    [' V2.0.0-rc.1 ', '2.0.0-rc.1'],
    ['0.1.0', '0.1.0'],
  ])
    assert.equal(normalizeReleaseVersion(value), expected);
  for (const value of [
    '',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.3-rc.01',
    '1.2.3+build.2',
    '1.2.3;git tag x',
    '../1.2.3',
    '1.2.3\n4.5.6',
    '9007199254740992.0.0',
  ])
    assert.throws(() => normalizeReleaseVersion(value), /版本号/);
  assert.equal(parseReleaseArgs(['web', '--version', 'v1.5.1']).version, '1.5.1');
  assert.throws(() => parseReleaseArgs(['web', '--version']), /版本参数/);
  assert.throws(
    () => parseReleaseArgs(['web', '--version', '1.5.1', '--version', '1.5.2']),
    /只能指定一次/,
  );
  assert.throws(() => parseReleaseArgs(['clean', '--version', '1.5.1']), /clean/);
});

test('Android mapping validates minor/patch, positivity and Google Play versionCode ceiling', () => {
  assert.equal(androidVersionCode('1.5.0'), 10500);
  assert.equal(androidVersionCode('v1.5.1-rc.1'), 10501);
  assert.equal(androidVersionCode('210000.0.0'), 2100000000);
  for (const version of ['1.100.0', '1.0.100', '0.0.0', '210000.0.1']) {
    assert.throws(
      () => createReleasePlan(parseReleaseArgs(['android', '--version', version])),
      /Android/,
    );
    assert.throws(
      () => createReleasePlan(parseReleaseArgs(['all', '--version', version])),
      /Android/,
    );
  }
  assert.ok(createReleasePlan(parseReleaseArgs(['web', '--version', '1.100.0'])).length);
});

test('TTY version choice supports new/default versions while explicit and non-TTY choices do not prompt', async () => {
  for (const [answer, expected] of [
    ['v1.6.0\n', '1.6.0'],
    ['\n', '1.5.0'],
  ]) {
    const input = new PassThrough(),
      output = new PassThrough();
    let prompt = '';
    output.on('data', (chunk) => (prompt += chunk));
    const pending = selectReleaseVersion(parseReleaseArgs(['web']), {
      currentVersion: '1.5.0',
      isTTY: true,
      input,
      output,
    });
    input.write(answer);
    assert.equal((await pending).version, expected);
    assert.match(prompt, /发布版本.*1\.5\.0/);
    input.end();
    output.end();
  }
  const noPrompt = {
    currentVersion: '1.5.0',
    isTTY: true,
    input: new PassThrough(),
    output: new PassThrough(),
  };
  assert.equal(
    (await selectReleaseVersion(parseReleaseArgs(['web', '--version', 'v1.6.0']), noPrompt))
      .version,
    '1.6.0',
  );
  assert.equal((await selectReleaseVersion(parseReleaseArgs(['clean']), noPrompt)).version, null);
  assert.equal(
    (
      await selectReleaseVersion(parseReleaseArgs(['web']), {
        currentVersion: '1.5.0',
        isTTY: false,
      })
    ).version,
    '1.5.0',
  );
});

test('metadata update changes only three version strings, preserves dependency versions and can roll back exact bytes', async (t) => {
  const f = await fixture(t),
    update = await syncReleaseVersion(f.root, 'v1.5.1');
  assert.equal(update.version, '1.5.1');
  assert.equal(update.previousVersion, '1.5.0');
  assert.equal(update.changed, true);
  const [pkg, lock] = await f.current();
  assert.equal(pkg, f.pkg.replace('"version": "1.5.0"', '"version": "1.5.1"'));
  assert.equal(
    lock,
    f.lock
      .replace('"version": "1.5.0"', '"version": "1.5.1"')
      .replace('"version": "1.5.0"', '"version": "1.5.1"'),
  );
  assert.equal(JSON.parse(lock).packages['node_modules/example'].version, '1.5.0');
  assert.deepEqual((await readdir(f.root)).sort(), ['package-lock.json', 'package.json']);
  await update.rollback();
  assert.deepEqual(await f.current(), [f.pkg, f.lock]);
  assert.equal((await syncReleaseVersion(f.root, '1.5.0')).changed, false);
});

test('a partial filesystem failure restores prior metadata and removes temporary files', async (t) => {
  const f = await fixture(t);
  let failed = false;
  const fileSystem = {
    readFile,
    writeFile,
    rm,
    lstat,
    rename: async (from: string, to: string) => {
      if (!failed && to.endsWith('package-lock.json')) {
        failed = true;
        throw new Error('synthetic second rename failure');
      }
      return rename(from, to);
    },
  };
  await assert.rejects(
    syncReleaseVersion(f.root, '1.5.1', { fileSystem }),
    /synthetic second rename/,
  );
  assert.deepEqual(await f.current(), [f.pkg, f.lock]);
  assert.deepEqual((await readdir(f.root)).sort(), ['package-lock.json', 'package.json']);
});

test('invalid lock metadata fails before writes and rollback never overwrites subsequent user edits', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'package-lock.json'), '{"name":"noetic-atlas","version":"1.5.0"}');
  await assert.rejects(syncReleaseVersion(f.root, '1.5.1'), /版本元数据/);
  assert.equal((await f.current())[0], f.pkg);
  await writeFile(join(f.root, 'package-lock.json'), f.lock);
  const update = await syncReleaseVersion(f.root, '1.5.1');
  const edited = (await f.current())[0] + ' ';
  await writeFile(join(f.root, 'package.json'), edited);
  await assert.rejects(update.rollback(), /其他操作修改/);
  assert.equal((await f.current())[0], edited);
});

test('dry-run uses requested version and filenames with zero fixture mutation or signing access', async (t) => {
  const f = await fixture(t),
    options = parseReleaseArgs([
      'all',
      '--version',
      'v1.6.2',
      '--dry-run',
      '--docker-command-only',
    ]);
  const result = await executeRelease(options, {
    root: f.root,
    platform: 'win32',
    env: { PATH: '' },
  });
  assert.equal(result.version, '1.6.2');
  assert.deepEqual(result.expectedArtifacts, expectedReleaseArtifacts('all', '1.6.2'));
  assert.ok(result.expectedArtifacts.includes('noetic-atlas-1.6.2-android.apk'));
  assert.ok(
    result.steps.find((step: any) => step.target === 'docker').args.includes('noetic-atlas:1.6.2'),
  );
  assert.deepEqual(await f.current(), [f.pkg, f.lock]);
  assert.equal((await readdir(f.root)).length, 2);
});

test('missing Android signing fails before version mutation, and command-only Docker retains current metadata', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    executeRelease(parseReleaseArgs(['android', '--version', '1.6.0']), {
      root: f.root,
      platform: 'linux',
      env: {},
    }),
    /签名/,
  );
  assert.deepEqual(await f.current(), [f.pkg, f.lock]);
  const result = await executeRelease(
    parseReleaseArgs(['docker', '--version', '1.6.0', '--docker-command-only']),
    { root: f.root, platform: 'linux', env: { PATH: '' } },
  );
  assert.equal(result.version, '1.6.0');
  assert.deepEqual(await f.current(), [f.pkg, f.lock]);
});

test('a failed check sees synchronized versions and rolls both files back without running a build', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(
    executeRelease(parseReleaseArgs(['source', '--version', '1.6.0']), {
      root: f.root,
      platform: 'linux',
      env: process.env,
      commandRunner: () => {
        calls++;
        assert.equal(
          JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).version,
          '1.6.0',
        );
        const lock = JSON.parse(readFileSync(join(f.root, 'package-lock.json'), 'utf8'));
        assert.equal(lock.version, '1.6.0');
        assert.equal(lock.packages[''].version, '1.6.0');
        throw new Error('synthetic pre-build check failure');
      },
    }),
    /synthetic pre-build check failure/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(await f.current(), [f.pkg, f.lock]);
  const report = JSON.parse(
    await readFile(join(f.root, 'artifacts/releases/release-report.json'), 'utf8'),
  );
  assert.equal(report.version, '1.6.0');
  assert.equal(report.targets[0].status, 'failed');
  assert.deepEqual(report.artifacts, []);
});
