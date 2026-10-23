import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isBuiltin } from 'node:module';
import ts from 'typescript';

function projectRoot() {
  let folder = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(folder, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === 'noetic-atlas') return folder;
    const parent = dirname(folder); if (parent === folder) throw new Error('Project root not found'); folder = parent;
  }
}
const root = projectRoot();
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.css']);
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}
const sources = () => ['server', 'shared', 'web'].flatMap(name => sourceFiles(join(root, name)));
interface Dependency { specifier: string; line: number; asset?: boolean }
function dependencies(file: string): Dependency[] {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.css')) {
    // CSS bare paths are relative too. Comments and data/HTTP/root URLs are not.
    const content = text.replace(/\/\*[\s\S]*?\*\//g, ''); const result: Dependency[] = [];
    for (const match of content.matchAll(/@import\s+['"]([^'"]+)['"]|url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g)) {
      const specifier = match[1] || match[2];
      if (specifier && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(specifier)) result.push({ specifier: specifier.startsWith('.') ? specifier : './' + specifier, line: content.slice(0, match.index).split('\n').length, asset: true });
    }
    return result;
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result: Dependency[] = [];
  const add = (node: ts.Node | undefined, asset = false) => {
    if (node && (ts.isStringLiteralLike(node))) result.push({ specifier: node.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, ...(asset ? { asset } : {}) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1]?.getText(source) === 'import.meta.url') add(node.arguments[0], true);
    ts.forEachChild(node, visit);
  };
  visit(source); return result;
}
function localTarget(importer: string, specifier: string) {
  const clean = specifier.replace(/[?#].*$/, ''); const target = resolve(dirname(importer), clean); const extension = extname(target);
  const candidates = extension === '.js' ? [target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx', target.slice(0, -3) + '.d.ts', target]
    : extension === '.mjs' ? [target.slice(0, -4) + '.mts', target.slice(0, -4) + '.d.mts', target]
    : extension === '.cjs' ? [target.slice(0, -4) + '.cts', target.slice(0, -4) + '.d.cts', target]
    : extension ? [target] : [target, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.json', '.css'].flatMap(suffix => [target + suffix, join(target, 'index' + suffix)])];
  return candidates.find(path => existsSync(path) && statSync(path).isFile());
}
function layer(path: string) { return relative(root, path).replaceAll('\\', '/').split('/')[0]!.toLowerCase(); }
function diagnostic(file: string, dependency: Dependency, message: string) { return `${relative(root, file).replaceAll('\\', '/')}:${dependency.line}: ${dependency.specifier} — ${message}`; }

test('all local static, type, re-export, dynamic imports and relative assets resolve after module moves', () => {
  const unresolved: string[] = []; let checked = 0;
  for (const file of sources()) for (const dependency of dependencies(file)) {
    if (!dependency.specifier.startsWith('.')) continue;
    checked++; if (!localTarget(file, dependency.specifier)) unresolved.push(diagnostic(file, dependency, 'local target does not exist'));
  }
  assert.ok(checked > 0, 'Dependency scan must inspect the actual source tree');
  assert.deepEqual(unresolved, [], 'Broken local imports or moved assets:\n' + unresolved.join('\n'));
});

test('shared stays platform independent and browser code cannot import server implementation', () => {
  const violations: string[] = [];
  for (const file of sources()) {
    const owner = layer(file); if (owner !== 'shared' && owner !== 'web') continue;
    for (const dependency of dependencies(file)) {
      const specifier = dependency.specifier;
      if (owner === 'shared' && (isBuiltin(specifier) || specifier.startsWith('node:') || /^@capacitor(?:\/|$)/.test(specifier) || specifier === '@platform' || /^electron(?:\/|$)/.test(specifier))) {
        violations.push(diagnostic(file, dependency, 'shared cannot depend on a runtime or platform adapter')); continue;
      }
      const target = specifier.startsWith('.') ? localTarget(file, specifier) : undefined;
      if (!target) continue;
      const destination = layer(target);
      if (owner === 'shared' && ['server', 'web', 'mobile', 'desktop'].includes(destination)) violations.push(diagnostic(file, dependency, 'shared cannot depend on an application layer'));
      if (owner === 'web' && destination === 'server') violations.push(diagnostic(file, dependency, 'browser code cannot import server implementation'));
    }
  }
  assert.deepEqual(violations, [], 'Platform boundary violations:\n' + violations.join('\n'));
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
