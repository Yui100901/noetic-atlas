import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  nativeRuntimeFingerprint,
  prepareNativeRuntimeBundle,
} from '../../scripts/testing/native-runtime-bundle.mjs';

const execute = promisify(execFile);
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'noetic-runtime-cache-'));
  for (const folder of ['mobile', 'server', 'shared']) await mkdir(join(root, folder));
  for (const path of ['package.json', 'package-lock.json']) await writeFile(join(root, path), '{}');
  await writeFile(join(root, 'mobile/runtime.ts'), 'export const fixture = 1;');
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { root, cacheRoot: join(root, 'cache') };
}

test('native bundle fingerprint follows source/lock contents and excludes generated assets', async (t) => {
  const { root } = await fixture(t);
  const first = await nativeRuntimeFingerprint(root);
  await mkdir(join(root, 'mobile/assets'));
  await writeFile(join(root, 'mobile/assets/generated.json'), '{"private":true}');
  assert.equal(await nativeRuntimeFingerprint(root), first);
  await mkdir(join(root, 'server/modules/assets'), { recursive: true });
  await writeFile(
    join(root, 'server/modules/assets/service.ts'),
    'export const attachmentRule = 1;',
  );
  const withAssets = await nativeRuntimeFingerprint(root);
  assert.notEqual(withAssets, first);
  await writeFile(
    join(root, 'server/modules/assets/service.ts'),
    'export const attachmentRule = 2;',
  );
  assert.notEqual(
    await nativeRuntimeFingerprint(root),
    withAssets,
    'real attachment modules are not generated assets',
  );
  await writeFile(join(root, 'shared/change.ts'), 'export const changed = true;');
  const changed = await nativeRuntimeFingerprint(root);
  assert.notEqual(changed, first);
  await writeFile(join(root, 'package-lock.json'), '{"version":2}');
  assert.notEqual(await nativeRuntimeFingerprint(root), changed);
});

test('concurrent native bundle requests publish once and reuse only complete code', async (t) => {
  const paths = await fixture(t);
  let builds = 0;
  const compile = async (_root: string, destination: string) => {
    builds++;
    await delay(100);
    await writeFile(join(destination, 'runtime.mjs'), 'export const completed = true;');
  };
  const modules = await Promise.all(
    Array.from({ length: 5 }, () => prepareNativeRuntimeBundle({ ...paths, compile })),
  );
  assert.equal(builds, 1);
  assert.equal(new Set(modules).size, 1);
  assert.equal((await import(pathToFileURL(modules[0]).href)).completed, true);
  await prepareNativeRuntimeBundle({ ...paths, compile });
  assert.equal(builds, 1);
});

test('independent Node processes cannot import or overwrite an unfinished native bundle', async (t) => {
  const paths = await fixture(t);
  const helper = pathToFileURL(resolve('scripts/testing/native-runtime-bundle.mjs')).href;
  const source = `import {prepareNativeRuntimeBundle} from ${JSON.stringify(helper)};import {appendFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {pathToFileURL} from 'node:url';import {setTimeout as delay} from 'node:timers/promises';
const [root,cacheRoot]=process.argv.slice(1);const bundle=await prepareNativeRuntimeBundle({root,cacheRoot,compile:async(_root,destination)=>{await appendFile(join(root,'builds.log'),'x');await delay(150);await writeFile(join(destination,'runtime.mjs'),'export const complete=true;');}});console.log(JSON.stringify({bundle,complete:(await import(pathToFileURL(bundle).href)).complete}));`;
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      execute(
        process.execPath,
        ['--input-type=module', '-e', source, paths.root, paths.cacheRoot],
        { windowsHide: true },
      ),
    ),
  );
  const values = results.map((result) => JSON.parse(result.stdout.trim()));
  assert.equal(new Set(values.map((value) => value.bundle)).size, 1);
  assert.ok(values.every((value) => value.complete));
  assert.equal(await readFile(join(paths.root, 'builds.log'), 'utf8'), 'x');
});

test('native compile failures remove partial output and release only their own lock', async (t) => {
  const paths = await fixture(t);
  await assert.rejects(
    prepareNativeRuntimeBundle({
      ...paths,
      compile: async (_root: string, destination: string) => {
        await writeFile(join(destination, 'runtime.mjs'), 'broken');
        throw Error('synthetic compilation failure');
      },
    }),
    /synthetic compilation failure/,
  );
  const bundle = await prepareNativeRuntimeBundle({
    ...paths,
    compile: async (_root: string, destination: string) => {
      await writeFile(join(destination, 'runtime.mjs'), 'export const repaired=true;');
    },
  });
  assert.ok((await stat(bundle)).size);
  assert.equal((await import(pathToFileURL(bundle).href)).repaired, true);
});

test('module reuse still gives independent native shim globals for each helper call', async (t) => {
  const paths = await fixture(t),
    module = join(paths.root, 'fixture-runtime.mjs');
  await writeFile(module, 'let value=0;export function createLocalRuntime(){return ++value;}');
  const source = `import {loadNativeRuntime} from ${JSON.stringify(pathToFileURL(resolve('tests/helpers/native-runtime.ts')).href)};const first=await loadNativeRuntime(),second=await loadNativeRuntime();console.log(JSON.stringify({first:first.createLocalRuntime(),second:second.createLocalRuntime(),again:first.createLocalRuntime()}));`;
  const result = await execute(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', source],
    {
      cwd: resolve('.'),
      env: { ...process.env, NOETIC_NATIVE_TEST_BUNDLE: module },
      windowsHide: true,
    },
  );
  assert.deepEqual(JSON.parse(result.stdout.trim()), { first: 1, second: 1, again: 2 });
});
