import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  windowsServerDependencies,
  assertWindowsServerLock,
} from '../../scripts/release/windows-server-dependencies.mjs';
import { parseDependencies } from '../../scripts/testing/source-dependencies.mjs';

async function fixture(t: test.TestContext, source: string) {
  const root = await mkdtemp(join(tmpdir(), 'noetic-windows-deps-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(root.includes('noetic-windows-deps-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'dist/server'), { recursive: true });
  await mkdir(join(root, 'dist/shared'), { recursive: true });
  await writeFile(join(root, 'dist/server/index.js'), source);
  return root;
}

test('Windows server installs only compiled module roots while retaining locked nested package resources', async (t) => {
  const root = await fixture(
    t,
    `import server from 'fastify';export {parse} from 'zod/v4';await import('@fastify/swagger-ui');import fs from 'node:fs';import './local.js';`,
  );
  const manifest = {
    name: 'noetic-atlas',
    version: '2.0',
    dependencies: {
      fastify: '^5.0.0',
      zod: '^4.0.0',
      '@fastify/swagger-ui': '^6.0.0',
      'lucide-react': '^0.468.0',
      'sql.js': '^1.15.0',
    },
    scripts: { postinstall: 'never-execute' },
    devDependencies: { vite: '^8.0.0' },
  };
  const packages = Object.fromEntries(
    Object.keys(manifest.dependencies).map((name) => [
      `node_modules/${name}`,
      {
        version: '1.0.0',
        integrity: 'sha512-locked',
        resolved: 'https://example.invalid/locked.tgz',
      },
    ]),
  );
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { ...manifest },
      ...packages,
      'node_modules/@fastify/swagger-ui/node_modules/static-resource': {
        version: '2.0.0',
        integrity: 'sha512-resource',
        resolved: 'https://example.invalid/static-resource.tgz',
      },
    },
  };
  const before = structuredClone(lock);
  const result = await windowsServerDependencies(root, manifest, lock);
  assert.deepEqual(result.directPackages, ['@fastify/swagger-ui', 'fastify', 'zod']);
  assert.equal(result.manifest.dependencies['lucide-react'], undefined);
  assert.equal(result.manifest.dependencies['sql.js'], undefined);
  assert.equal('scripts' in result.manifest, false);
  assert.equal('devDependencies' in result.lock.packages[''], false);
  assert.deepEqual(result.lock.packages[''].dependencies, result.manifest.dependencies);
  assert.deepEqual(
    result.lock.packages['node_modules/@fastify/swagger-ui/node_modules/static-resource'],
    lock.packages['node_modules/@fastify/swagger-ui/node_modules/static-resource'],
  );
  assert.deepEqual(lock, before);
});

test('Windows dependency selection fails closed on undeclared, unpinned and computed modules', async (t) => {
  const root = await fixture(t, `import 'undeclared';`);
  const manifest = { name: 'test', version: '1.0', dependencies: { fastify: '5.0.0' } };
  const lock = { packages: { '': {}, 'node_modules/fastify': { version: '5.0.0' } } };
  await assert.rejects(windowsServerDependencies(root, manifest, lock), /未声明/);
  await writeFile(join(root, 'dist/server/index.js'), `import 'fastify';`);
  await assert.rejects(windowsServerDependencies(root, manifest, lock), /缺少锁定校验/);
  await writeFile(join(root, 'dist/server/index.js'), `const name='fastify';\nawait import(name);`);
  await assert.rejects(windowsServerDependencies(root, manifest, lock), /index\.js:2/);
});

test('strict dependency parsing includes literal dynamic imports and rejects computed require without changing normal inspection', () => {
  const source = `// require(variable) in a comment is harmless\nimport('fastify');\nrequire(variable);`;
  assert.deepEqual(
    parseDependencies('fixture.mjs', source).map((value) => value.specifier),
    ['fastify'],
  );
  assert.throws(
    () => parseDependencies('fixture.mjs', source, { rejectDynamicModules: true }),
    /fixture\.mjs:3/,
  );
});

test('Windows lock normalization accepts only removal and metadata flags, never replacement artifacts', () => {
  const locked = {
    version: '5.0.0',
    integrity: 'sha512-original',
    resolved: 'https://registry.npmjs.org/fastify/-/fastify-5.0.0.tgz',
  };
  const original = {
    packages: {
      '': {},
      'node_modules/fastify': locked,
      'node_modules/unused': { version: '1.0.0' },
    },
  };
  const selected = {
    packages: {
      '': { dependencies: { fastify: '^5.0.0' } },
      'node_modules/fastify': { ...locked, dev: false },
    },
  };
  assert.doesNotThrow(() => assertWindowsServerLock(original, selected));
  for (const changes of [
    { version: '5.1.0' },
    { integrity: 'sha512-other' },
    { resolved: 'https://example.invalid/substitution.tgz' },
  ])
    assert.throws(
      () =>
        assertWindowsServerLock(original, {
          packages: { 'node_modules/fastify': { ...locked, ...changes } },
        }),
      /改变了锁定对象/,
    );
  assert.throws(
    () => assertWindowsServerLock(original, { packages: { 'node_modules/new': locked } }),
    /改变了锁定对象/,
  );
});
