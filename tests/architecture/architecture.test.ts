import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDependencyIndex, sourceFiles, layer as sourceLayer, diagnostic as sourceDiagnostic, inspectBoundaries, inspectNativeGraph } from '../../scripts/testing/source-dependencies.mjs';
import { nativeAliases } from '../../mobile/vite-aliases.ts';

function projectRoot() {
  let folder = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(folder, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'noetic-atlas') return folder;
    const parent = dirname(folder); if (parent === folder) throw new Error('Project root not found'); folder = parent;
  }
}
const root = projectRoot();
const index = createDependencyIndex(root);
const sources = () => index.files;
const dependencies = index.dependencies;
const localTarget = index.target;
const layer = (file: string) => sourceLayer(root, file);
const diagnostic = (file: string, dependency: { specifier: string; line: number }, message: string) => sourceDiagnostic(root, file, dependency, message);

test('all local static, type, re-export, dynamic imports and relative assets resolve after module moves', () => {
  const unresolved: string[] = []; let checked = 0;
  for (const file of sources()) for (const dependency of dependencies(file)) {
    if (!dependency.specifier.startsWith('.')) continue;
    checked++; if (!localTarget(file, dependency.specifier)) unresolved.push(diagnostic(file, dependency, 'local target does not exist'));
  }
  assert.ok(checked > 0, 'Dependency scan must inspect the actual source tree');
  assert.deepEqual(unresolved, [], 'Broken local imports or moved assets:\n' + unresolved.join('\n'));
});

test('shared, browser, server and mobile respect platform dependency boundaries', () => {
  const report = inspectBoundaries(index);
  assert.deepEqual(report.violations, [], 'Platform boundary violations:\n' + report.violations.join('\n'));
});

test('every first-party Node service reachable from Android has a real mobile adapter', () => {
  const report = inspectNativeGraph(index, nativeAliases);
  assert.ok(report.firstPartyFiles > 0);
  assert.ok(report.adaptedModules.includes('node:sqlite'));
  assert.deepEqual(report.violations, [], 'Unadapted native runtime imports:\n' + report.violations.join('\n'));
});

test('reusable question and paper components keep route pages out of their dependency graph', () => {
  const entryPages = new Set(['questions/questions.tsx', 'papers/paper-editor.tsx'].map(file => join(root, 'web/features', file)));
  const violations: string[] = [];
  const feature = (file: string) => relative(join(root, 'web/features'), file).replaceAll('\\', '/').split('/')[0];
  // Same-feature page composition (for example the vocabulary reference page)
  // is valid. Other features must consume the extracted reusable modules.
  for (const file of sourceFiles(join(root, 'web/features'))) for (const dependency of dependencies(file)) {
    if (!dependency.specifier.startsWith('.')) continue;
    const target = localTarget(file, dependency.specifier);
    if (target && entryPages.has(target) && feature(file) !== feature(target)) violations.push(diagnostic(file, dependency, 'import reusable components instead of another feature\'s route page'));
  }
  // Check transitive dependencies too: a helper must not reintroduce a heavy
  // route chunk indirectly through a new barrel or component import.
  const checked = new Set<string>();
  const visit = (file: string) => {
    if (checked.has(file)) return;
    checked.add(file);
    for (const dependency of dependencies(file)) {
      if (!dependency.specifier.startsWith('.')) continue;
      const target = localTarget(file, dependency.specifier);
      if (!target) continue;
      if (entryPages.has(target)) violations.push(diagnostic(file, dependency, 'reusable component graph cannot depend on a route page'));
      else if (/\.[cm]?[jt]sx?$/.test(target)) visit(target);
    }
  };
  for (const file of ['questions/question-filters.tsx', 'questions/question-row.tsx', 'questions/question-preview.tsx', 'papers/random-filters.tsx']) visit(join(root, 'web/features', file));
  assert.deepEqual(violations, [], 'Page/component boundary violations:\n' + violations.join('\n'));
});

test('paper list and question viewer action layouts have one stylesheet owner', () => {
  const owners = new Map([
    ['.paper-list-tools', 'web/features/papers/paper-organization.css'],
    ['.question-viewer-feedback', 'web/features/questions/question-viewer.css'],
  ]);
  for (const [selector, owner] of owners) {
    const files = sourceFiles(join(root, 'web')).filter(file => file.endsWith('.css') && readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').includes(selector));
    assert.deepEqual(files.map(file => relative(root, file).replaceAll('\\', '/')).sort(), [owner], selector + ' must not depend on route stylesheet loading order');
  }
});

test('platform aliases use actual Vite resolution and remain exact in browser and Android builds', async () => {
  const { resolveConfig } = await import('vite');
  const importer = join(root, 'web/app/main.tsx');
  const browser = await resolveConfig({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'silent' }, 'build');
  const native = await resolveConfig({ root, configFile: join(root, 'vite.mobile.config.ts'), logLevel: 'silent' }, 'build');
  const browserResolve = browser.createResolver(), nativeResolve = native.createResolver();
  const browserPlatform = await browserResolve('@platform', importer), nativePlatform = await nativeResolve('@platform', importer);
  assert.ok(browserPlatform && existsSync(browserPlatform)); assert.equal(layer(browserPlatform!), 'web');
  assert.ok(nativePlatform && existsSync(nativePlatform)); assert.equal(layer(nativePlatform!), 'mobile');
  assert.notEqual(browserPlatform, nativePlatform, 'Native builds must not accidentally keep the browser transport');
  assert.ok(!(await browserResolve('@platform/not-a-module', importer)), 'Browser alias must not rewrite arbitrary @platform subpaths');
  assert.ok(!(await nativeResolve('@platform/not-a-module', importer)), 'Native alias must not rewrite arbitrary @platform subpaths');
  for (const specifier of ['node:sqlite', 'node:fs', 'fastify']) {
    const resolved = await nativeResolve(specifier, join(root, 'server/index.ts'));
    assert.ok(resolved && existsSync(resolved), specifier + ' must resolve to a real Android shim');
    assert.equal(layer(resolved!), 'mobile', specifier + ' must use its mobile adapter');
  }
});

test('server root contains only startup entries and buildApp still assembles the public modules', async t => {
  const topLevel = readdirSync(join(root, 'server'), { withFileTypes: true }).filter(entry => entry.isFile() && /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)).map(entry => entry.name).sort();
  assert.deepEqual(topLevel, ['index.ts', 'main.ts'], 'Server implementation belongs in modules/core/http/database rather than the startup directory');
  const { buildApp } = await import(pathToFileURL(join(root, 'server/index.ts')).href);
  const app = await buildApp({ databasePath: ':memory:', seedPath: join(root, 'test-results/architecture-no-seed.json'), staticRoot: join(root, 'test-results/architecture-no-static') });
  t.after(async () => { await app.close(); });
  for (const path of ['/api/health', '/api/bootstrap', '/api/taxonomy', '/api/questions', '/api/study', '/api/papers', '/api/attempts', '/api/documents', '/api/ai/settings']) {
    const response = await app.inject({ method: 'GET', url: path }); assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
  }
  const document = await app.inject({ method: 'GET', url: '/api/openapi.json' }); assert.equal(document.statusCode, 200);
  const paths = document.json().paths;
  for (const path of ['/api/questions', '/api/domains', '/api/study/{id}', '/api/papers', '/api/attempts', '/api/export', '/api/import', '/api/backup.sqlite']) assert.ok(paths[path], path + ' must still be registered');
});
