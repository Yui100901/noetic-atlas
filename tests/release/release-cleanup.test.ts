import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// @ts-expect-error Release tooling deliberately runs without a TypeScript runtime.
import { cleanupReleaseArtifacts } from '../../scripts/release/cleanup.mjs';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'noetic-release-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name: string, value = name) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), value);
  };
  await put('package.json', '{"name":"noetic-atlas","version":"1.0.0"}');
  return { root, put };
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = async (path: string) => { await assert.rejects(stat(path), { code: 'ENOENT' }); };

test('release cleanup archives complete domain packages and removes only approved software outputs', async t => {
  const { root, put } = await fixture(t);
  const domainFiles = [
    'noetic-atlas-content-computer-science-1.0.0.zip', 'domain-manifest.json',
    'CONTENT-SHA256SUMS.txt', 'licenses/NOTICE.md', 'sources/manifest.json',
  ];
  const expected = new Map<string, string>();
  for (const name of domainFiles) {
    await put(`artifacts/domain-packs/v1.0.0/${name}`);
    expected.set(name, digest(await readFile(join(root, `artifacts/domain-packs/v1.0.0/${name}`))));
  }
  await mkdir(join(root, 'artifacts/domain-packs/v1.0.0/empty'), { recursive: true });
  const outputs = [
    'artifacts/releases/runtime.zip', 'artifacts/github/v1.0.0/android.apk',
    'artifacts/windows/noetic-atlas.exe', 'artifacts/noetic-atlas-release.apk',
    'artifacts/noetic-atlas-release.apk.idsig', 'artifacts/noetic-atlas-debug.apk',
    'artifacts/android-signing-report.json', 'dist/apk/release.apk',
    'android/app/build/intermediates/apk.bin', 'android/build/reports/report.html',
    '.localtools/release-staging/generated.zip',
  ];
  for (const name of outputs) await put(name);
  const kept = [
    'data/noetic-atlas.sqlite', 'data/noetic-atlas.sqlite-wal',
    '.localtools/signing/release/key.jks', '.localtools/signing/release/password.json',
    '.localtools/android-sdk/platform-tools/adb.exe', 'dist/server/main.js',
    'node_modules/package/index.js', 'test-results/report.json', 'artifacts/other-owned-file.txt',
  ];
  for (const name of kept) await put(name);

  const report = await cleanupReleaseArtifacts({ root });
  assert.equal(report.archived.length, 1);
  assert.equal(report.archived[0].deduplicated, false);
  assert.equal(report.archived[0].files, domainFiles.length);
  for (const [name, hash] of expected) assert.equal(digest(await readFile(join(root, `data/release-archives/domain-packs/v1.0.0/${name}`))), hash);
  assert.deepEqual(await readdir(join(root, 'data/release-archives/domain-packs/v1.0.0/empty')), []);
  await missing(join(root, 'artifacts/domain-packs'));
  for (const name of outputs) await missing(join(root, name));
  for (const name of kept) assert.equal(await readFile(join(root, name), 'utf8'), name);
  assert.ok(report.removedBytes > 0);
  assert.deepEqual(await cleanupReleaseArtifacts({ root }), { dryRun: false, archived: [], removed: [], removedBytes: 0 });
});

test('identical complete archives are verified and deduplicated without overwriting metadata', async t => {
  const { root, put } = await fixture(t);
  for (const prefix of ['artifacts/domain-packs/v1.0.0', 'data/release-archives/domain-packs/v1.0.0']) {
    await put(`${prefix}/questions.zip`, 'same content bytes');
    await put(`${prefix}/LICENSE.md`, 'same license');
  }
  const target = join(root, 'data/release-archives/domain-packs/v1.0.0/questions.zip');
  const before = await stat(target);
  const report = await cleanupReleaseArtifacts({ root });
  assert.equal(report.archived[0].deduplicated, true);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  await missing(join(root, 'artifacts/domain-packs'));
});

test('a differing archive hash stops all cleanup and preserves both full copies', async t => {
  const { root, put } = await fixture(t);
  await put('artifacts/domain-packs/v1.0.0/questions.zip', 'new bytes');
  await put('data/release-archives/domain-packs/v1.0.0/questions.zip', 'old bytes');
  await put('artifacts/releases/runtime.zip', 'release bytes');
  await assert.rejects(cleanupReleaseArtifacts({ root }), /归档冲突/);
  assert.equal(await readFile(join(root, 'artifacts/domain-packs/v1.0.0/questions.zip'), 'utf8'), 'new bytes');
  assert.equal(await readFile(join(root, 'data/release-archives/domain-packs/v1.0.0/questions.zip'), 'utf8'), 'old bytes');
  assert.equal(await readFile(join(root, 'artifacts/releases/runtime.zip'), 'utf8'), 'release bytes');
});

test('missing licenses or extra files in existing archive are collisions, even with identical ZIP bytes', async t => {
  const { root, put } = await fixture(t);
  await put('artifacts/domain-packs/v1.0.0/questions.zip', 'same');
  await put('data/release-archives/domain-packs/v1.0.0/questions.zip', 'same');
  await put('artifacts/domain-packs/v1.0.0/LICENSE.md', 'required attribution');
  await assert.rejects(cleanupReleaseArtifacts({ root }), /归档冲突/);
  assert.equal(await readFile(join(root, 'artifacts/domain-packs/v1.0.0/LICENSE.md'), 'utf8'), 'required attribution');
});

test('dry run reports complete actions but never creates archives or removes files', async t => {
  const { root, put } = await fixture(t);
  await put('artifacts/domain-packs/v1.0.0/questions.zip', 'questions');
  await put('artifacts/releases/runtime.zip', 'release');
  const report = await cleanupReleaseArtifacts({ root, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.archived[0].files, 1);
  assert.equal(report.removed[0].path, 'artifacts/releases');
  assert.equal(report.removedBytes, 7);
  await missing(join(root, 'data/release-archives'));
  assert.equal(await readFile(join(root, 'artifacts/releases/runtime.zip'), 'utf8'), 'release');
  assert.equal(await readFile(join(root, 'artifacts/domain-packs/v1.0.0/questions.zip'), 'utf8'), 'questions');
});

test('a symlink or junction in software output cannot cross the project boundary', async t => {
  const { root, put } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'noetic-cleanup-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'never-delete.txt'), 'keep');
  await put('artifacts/releases/runtime.zip', 'release');
  await symlink(outside, join(root, 'artifacts/releases/outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanupReleaseArtifacts({ root }), /链接|联接|越界/);
  assert.equal(await readFile(join(outside, 'never-delete.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(join(root, 'artifacts/releases/runtime.zip'), 'utf8'), 'release');
});

test('an archive destination reached through a junction is rejected before any mutation', async t => {
  const { root, put } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'noetic-cleanup-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await put('artifacts/domain-packs/v1.0.0/questions.zip', 'content');
  await symlink(outside, join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(cleanupReleaseArtifacts({ root }), /链接|联接|越界/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await readFile(join(root, 'artifacts/domain-packs/v1.0.0/questions.zip'), 'utf8'), 'content');
});

test('database files, user data folders and private keys in software output block every deletion', async t => {
  for (const unsafe of ['artifacts/windows/session.sqlite-wal', 'artifacts/windows/session.db', 'artifacts/windows/data/settings.json', '.localtools/release-staging/key.jks']) {
    const { root, put } = await fixture(t);
    await put(unsafe, 'private');
    await put('artifacts/releases/runtime.zip', 'release');
    await put('artifacts/domain-packs/v1.0.0/questions.zip', 'content');
    await assert.rejects(cleanupReleaseArtifacts({ root }), /用户数据、数据库或签名私钥/);
    assert.equal(await readFile(join(root, unsafe), 'utf8'), 'private');
    assert.equal(await readFile(join(root, 'artifacts/releases/runtime.zip'), 'utf8'), 'release');
    assert.equal(await readFile(join(root, 'artifacts/domain-packs/v1.0.0/questions.zip'), 'utf8'), 'content');
    await missing(join(root, 'data/release-archives'));
  }
});

test('Git tracked release-looking files are never removed, including in a parent repository', async t => {
  const { root, put } = await fixture(t);
  await put('artifacts/releases/keep.txt', 'tracked output');
  for (const args of [['init', '--quiet'], ['add', 'artifacts/releases/keep.txt']]) {
    const command = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(command.status, 0, command.stderr);
  }
  await assert.rejects(cleanupReleaseArtifacts({ root }), /Git 已跟踪/);
  assert.equal(await readFile(join(root, 'artifacts/releases/keep.txt'), 'utf8'), 'tracked output');
  const nested = join(root, 'nested-project');
  await put('nested-project/package.json', '{"name":"noetic-atlas"}');
  await put('nested-project/artifacts/releases/keep.txt', 'nested tracked');
  const add = spawnSync('git', ['-C', root, 'add', 'nested-project/artifacts/releases/keep.txt'], { encoding: 'utf8', windowsHide: true });
  assert.equal(add.status, 0, add.stderr);
  await assert.rejects(cleanupReleaseArtifacts({ root: nested }), /Git 已跟踪/);
});

test('a different project root is rejected even if output names match', async t => {
  const { root, put } = await fixture(t);
  await put('package.json', '{"name":"unrelated-project"}');
  await put('artifacts/releases/keep.zip', 'keep');
  await assert.rejects(cleanupReleaseArtifacts({ root }), /noetic-atlas 项目根目录/);
  assert.equal(await readFile(join(root, 'artifacts/releases/keep.zip'), 'utf8'), 'keep');
});


test('legacy content beside software is hash-archived before software removal', async t => {
  const { root, put } = await fixture(t);
  const name = 'noetic-atlas-1.0.0-content.zip';
  await put('artifacts/releases/' + name, 'complete legacy content');
  await put('artifacts/releases/runtime.zip', 'rebuildable software');
  const dry = await cleanupReleaseArtifacts({ root, dryRun: true });
  assert.equal(dry.archived.length, 1);
  assert.equal(await readFile(join(root, 'artifacts/releases', name), 'utf8'), 'complete legacy content');
  const result = await cleanupReleaseArtifacts({ root });
  assert.equal(result.archived[0].to, 'data/release-archives/legacy-content/' + name);
  assert.equal(result.removedBytes, Buffer.byteLength('rebuildable software'));
  assert.equal(await readFile(join(root, result.archived[0].to), 'utf8'), 'complete legacy content');
  await missing(join(root, 'artifacts/releases'));
});

test('legacy content archive collision prevents every software deletion', async t => {
  const { root, put } = await fixture(t);
  const name = 'noetic-atlas-1.0.0-content.zip';
  await put('artifacts/releases/' + name, 'new content');
  await put('data/release-archives/legacy-content/' + name, 'different previous content');
  await put('artifacts/releases/runtime.zip', 'software');
  await assert.rejects(cleanupReleaseArtifacts({ root }), /归档冲突/);
  assert.equal(await readFile(join(root, 'artifacts/releases', name), 'utf8'), 'new content');
  assert.equal(await readFile(join(root, 'artifacts/releases/runtime.zip'), 'utf8'), 'software');
});
