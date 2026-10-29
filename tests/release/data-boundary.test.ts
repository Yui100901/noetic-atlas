import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, glob } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
// @ts-expect-error Release tooling deliberately runs without a TypeScript runtime.
import { collectReleaseFiles, packageWebRelease } from '../../scripts/release/release-web.mjs';
// @ts-expect-error Release tooling deliberately runs without a TypeScript runtime.
import { validatePublicData, createEmptyPublicData, validateEmptyInstall } from '../../scripts/release/validate-public-data.mjs';

const root = resolve(import.meta.dirname, '../..');
async function fixture(t: TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'noetic-data-boundary-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const put = async (name: string, value: string) => {
    await mkdir(dirname(join(folder, name)), { recursive: true });
    await writeFile(join(folder, name), value);
  };
  return { folder, put };
}

function zipEntries(bytes: Buffer) {
  const files = new Map<string, Buffer>();
  let cursor = 0;
  while (bytes.readUInt32LE(cursor) === 0x04034b50) {
    const size = bytes.readUInt32LE(cursor + 18), nameSize = bytes.readUInt16LE(cursor + 26);
    const start = cursor + 30 + nameSize + bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 30, cursor + 30 + nameSize).toString('utf8');
    files.set(name.split('/').slice(1).join('/'), inflateRawSync(bytes.subarray(start, start + size)));
    cursor = start + size;
  }
  return files;
}

test('broad data and config inputs cannot ship any data or a custom configuration', async t => {
  const { folder, put } = await fixture(t);
  await put('data/seed.json', '{}');
  await put('data/content-sources/source.json', '{"license":"CC0-1.0"}');
  for (const name of ['data/content-packs/pack.json', 'data/desktop/browser/Preferences', 'data/ai-config.json', 'data/backups/config.json', 'data/noetic-atlas.sqlite', 'data/unknown-new-data/file.txt']) await put(name, 'private');
  await put('config/defaults.json','{}');
  await put('config/exported-private-settings.json','private');
  assert.deepEqual((await collectReleaseFiles(folder, ['data','config'])).map((file: any) => file.name), ['config/defaults.json']);
});

test('a link inside an allowed source folder cannot bypass the local-data exclusion', async t => {
  const { folder, put } = await fixture(t);
  await put('data/desktop/state.json', '{"token":"opaque-private-token"}');
  await mkdir(join(folder, 'docs'));
  await symlink(join(folder, 'data/desktop'), join(folder, 'docs/linked-state'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectReleaseFiles(folder, ['docs']), /受限本地文件/);
});

for (const version of ['1.0.0', '1.5']) {
test(`source and runtime ZIPs preserve ${version} and contain only base configuration without local data`, async t => {
  const { folder, put } = await fixture(t);
  await put('package.json', JSON.stringify({ name: 'noetic-atlas', version }));
  await put('LICENSE', 'Publisher-selected license fixture');
  await put('data/seed.json', '{"questions":[{"id":"NEVER-BUNDLE"}]}');
  await put('config/defaults.json',await readFile(join(root,'config/defaults.json'),'utf8'));
  await put('config/private-settings.json','{"token":"opaque-private-token"}');
  await put('data/content-sources/source.json', '{"license":"CC0-1.0"}');
  await put('data/content-packs/large-pack.json', '{"shouldNotShip":true}');
  await put('data/ai-config.json', '{"token":"private-local-token"}');
  await put('data/desktop/browser/Preferences', 'private-local-profile');
  const directories = ['docs','server','shared','web','mobile','android','desktop','scripts','public','dist/server','dist/shared','dist/web'];
  for (const directory of directories) await mkdir(join(folder, directory), { recursive: true });
  for (const name of ['package-lock.json','README.md','Dockerfile','compose.yaml','index.html','capacitor.config.ts','tsconfig.server.json','tsconfig.web.json','tsconfig.mobile.json','vite.config.ts','vite.mobile.config.ts','.gitignore','.dockerignore','.gitattributes','启动学习站.cmd','release.cmd','release.ps1','release.sh']) await put(name, 'fixture');
  await put('docs/API-CONTRACT.md', 'API contract fixture');
  await mkdir(join(folder, 'tests'));
  await put('scripts/build/android-build.mjs', 'export const sourceBuildTool = true;');
  await put('android/app/build/intermediates/generated.txt', 'Must not be shipped');
  await put('dist/package.json', JSON.stringify({ name: 'noetic-atlas', version, type: 'module' }));
  const result = await packageWebRelease({ root: folder });
  assert.equal(result.version, version);
  assert.deepEqual(result.artifacts.map((artifact: { file: string }) => artifact.file), [`noetic-atlas-${version}-source.zip`, `noetic-atlas-${version}-runtime.zip`]);
  assert.equal(result.artifacts.length, 2);
  for (const artifact of result.artifacts) {
    const bytes = await readFile(join(folder, 'artifacts/releases', artifact.file));
    const firstName = bytes.subarray(30, 30 + bytes.readUInt16LE(26)).toString('utf8');
    assert.ok(firstName.startsWith(`noetic-atlas-${version}/`));
    const entries = zipEntries(bytes);
    assert.equal(JSON.parse(entries.get('package.json')!.toString()).version, version);
    assert.deepEqual([...entries.keys()].filter(name => name.startsWith('data/')), []);
    assert.deepEqual([...entries.keys()].filter(name => name.startsWith('config/')), ['config/defaults.json']);
    assert.equal(entries.get('LICENSE')!.toString(), 'Publisher-selected license fixture');
    assert.equal(entries.get('docs/API-CONTRACT.md')!.toString(), 'API contract fixture');
    assert.ok(!entries.has('API-CONTRACT.md'));
    if (artifact.file.includes('-runtime.zip')) assert.equal(JSON.parse(entries.get('dist/package.json')!.toString()).version, version);
    if(artifact.file.includes('-source.zip'))assert.equal(entries.get('scripts/build/android-build.mjs')!.toString(),'export const sourceBuildTool = true;');
    assert.ok(!entries.has('android/app/build/intermediates/generated.txt'));
    const manifest = JSON.parse(entries.get('release-manifest.json')!.toString('utf8'));
    assert.equal(manifest.version, version);
    assert.equal(manifest.dataBoundary.expandedBanks, 'separate-content-release');
    assert.equal(manifest.dataBoundary.includesUserConfiguration, false);
    assert.equal(manifest.counts.questions, 0);
    assert.equal(manifest.dataBoundary.installation,'empty-install');
    assert.equal(manifest.dataBoundary.includesQuestionData,false);
  }
});
}

test('Git excludes the entire data directory and custom config while preserving only base config', async t => {
  if (spawnSync('git', ['--version']).status !== 0) { t.skip('Git is not installed'); return; }
  const { folder, put } = await fixture(t);
  await put('.gitignore', await readFile(join(root, '.gitignore'), 'utf8'));
  await put('empty-excludes', '');
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: folder }).status, 0);
  const privateNames = ['data/desktop/browser/Preferences','data/arbitrary-config.json','data/backups/export.json','data/content-packs/pack.json','data/other/subfolder/private.txt','data/seed.json','data/content-sources/example.json','data/content-sources/nested/NOTICE.txt','config/private-settings.json'];
  const publicNames = ['config/defaults.json'];
  const result = spawnSync('git', ['-c', `core.excludesFile=${join(folder, 'empty-excludes')}`, 'check-ignore', '--no-index', '--stdin'], { cwd: folder, input: [...privateNames, ...publicNames].join('\n') + '\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), privateNames);
});

test('Docker excludes all data and only copies default configuration', async () => {
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const ignore = await readFile(join(root, '.dockerignore'), 'utf8');
  assert.match(ignore, /^data$/m);
  assert.ok(!/^!data/m.test(ignore));
  assert.match(ignore,/^!config\/defaults\.json$/m);
  assert.match(dockerfile, /RUN npm run data:validate && npm run build/);
  assert.match(dockerfile, /COPY config\/defaults\.json \.\/config\/defaults\.json/);
  assert.ok(!/^(?:COPY|ENV).*data\/seed|SEED_PATH/m.test(dockerfile));
});

test('Docker build inputs include every bundled handbook source before the Web build', async () => {
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const build = dockerfile.indexOf('RUN npm run data:validate && npm run build');
  assert.ok(build > 0);
  const beforeBuild = dockerfile.slice(0, build);
  assert.match(beforeBuild, /^COPY docs \.\/docs\s*$/m);
  const rootInputs = new Set([...beforeBuild.matchAll(/^COPY\s+(.+?)\s+\.\/\s*$/gm)].flatMap(match => match[1].split(/\s+/)));
  for (const file of ['README.md']) assert.ok(rootInputs.has(file), `${file} must be copied before building`);

  // Follow the application's real raw-document glob list instead of keeping a
  // second handwritten list that could silently omit a newly bundled chapter.
  const handbook = join(root, 'web/features/help/handbook.tsx');
  const source = await readFile(handbook, 'utf8');
  const globList = source.match(/import\.meta\.glob\(\[([\s\S]*?)\]/)?.[1];
  assert.ok(globList, 'Expected the handbook raw-document imports');
  const patterns = [...globList.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(patterns.length > 0);
  const bundled = new Set<string>();
  for (const pattern of patterns) {
    const localPattern = relative(root, resolve(dirname(handbook), pattern)).replaceAll('\\', '/');
    assert.ok(localPattern.startsWith('docs/') || rootInputs.has(localPattern), `Uncopied handbook input: ${localPattern}`);
    let matches = 0;
    for await (const file of glob(pattern, { cwd: dirname(handbook) })) {
      const path = resolve(dirname(handbook), file);
      assert.ok((await readFile(path, 'utf8')).trim(), `Empty handbook input: ${file}`);
      bundled.add(relative(root, path).replaceAll('\\', '/')); matches++;
    }
    assert.ok(matches > 0, `Missing handbook input: ${pattern}`);
  }
  const main = source.match(/const main\s*=\s*'([^']+)'/)?.[1];
  assert.ok(main && bundled.has(main), 'The default manual must be available inside Docker');
});

test('empty-install validation rejects opaque configuration and any bundled taxonomy or questions', async () => {
  const seed=createEmptyPublicData();
  assert.throws(() => validatePublicData({ ...seed, credentials: { token: 'opaque-private-token' } }), /非公开字段/);
  assert.throws(() => validatePublicData({ ...seed, ai_settings: [] }), /非公开字段/);
  assert.equal(validateEmptyInstall(seed).questions,0);
  assert.throws(()=>validateEmptyInstall({...seed,domains:[{id:'example',name:'example'}]}),/空安装/);
});
