import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  boundaryViolations,
  createDependencyIndex,
  inspectBoundaries,
  inspectNativeGraph,
  localTarget,
  parseDependencies,
} from '../../scripts/testing/source-dependencies.mjs';

test('dependency parser sees real imports, types, re-exports and literal assets but ignores prose and comments', () => {
  const source = `// import fs from 'node:fs';
const prose = "import server from '../server/private'";
import type { Q } from './model.js';
export { other } from './other';
type Contract = typeof import('./contract');
const lazy = import('./lazy');
const legacy = require('./legacy');
import old = require('./old');
const asset = new URL('./font.ttf', import.meta.url);
`;
  assert.deepEqual(
    parseDependencies('example.ts', source).map((item: any) => [
      item.specifier,
      item.line,
      !!item.asset,
    ]),
    [
      ['./model.js', 3, false],
      ['./other', 4, false],
      ['./contract', 5, false],
      ['./lazy', 6, false],
      ['./legacy', 7, false],
      ['./old', 8, false],
      ['./font.ttf', 9, true],
    ],
  );
  assert.deepEqual(
    parseDependencies(
      'style.css',
      '/* url(ignored.png)\nmore text */\n.a { background: url(../image.png); }\n@import "./colors.css";\n.x {src:url(data:font/woff;base64,AA)}',
    ).map((item: any) => [item.specifier, item.line]),
    [
      ['../image.png', 3],
      ['./colors.css', 4],
    ],
  );
});

test('platform rules reject direct Node, device, database and reverse dependencies even in type-only syntax', () => {
  const root = resolve('test-results/virtual-boundary-root');
  const cases = [
    ['web/page.ts', 'fs/promises'],
    ['web/page.ts', 'node:child_process'],
    ['web/page.ts', '@capacitor/core'],
    ['web/page.ts', 'kysely'],
    ['web/page.ts', 'electron'],
    ['web/page.ts', '@platform/hidden'],
    ['web/page.ts', '../mobile/platform.ts', 'mobile/platform.ts'],
    ['web/page.ts', '../desktop/main.cjs', 'desktop/main.cjs'],
    ['shared/model.ts', '../server/private.ts', 'server/private.ts'],
    ['shared/model.ts', '@platform'],
    ['shared/model.ts', 'fastify'],
    ['server/service.ts', '../web/component.ts', 'web/component.ts'],
    ['server/service.ts', '@capacitor/filesystem'],
    ['mobile/service.ts', 'node:fs'],
    ['mobile/service.ts', '@fastify/static'],
    ['mobile/service.ts', '../web/page.ts', 'web/page.ts'],
    ['mobile/not-vite-aliases.ts', 'node:url'],
  ];
  for (const [file, specifier, destination] of cases) {
    const target = destination ? join(root, destination) : undefined;
    assert.ok(
      boundaryViolations(root, join(root, file!), { specifier, line: 1 }, target).length,
      `${file}: ${specifier} must be rejected`,
    );
  }
  const allowed = [
    ['web/page.ts', '@platform'],
    ['web/page.ts', '../shared/model.ts', 'shared/model.ts'],
    ['shared/model.ts', './other.ts', 'shared/other.ts'],
    ['shared/model.ts', 'zod'],
    ['server/service.ts', 'node:fs'],
    ['mobile/runtime.ts', '../server/index.ts', 'server/index.ts'],
    ['mobile/storage.ts', '@capacitor/filesystem'],
    ['mobile/vite-aliases.ts', 'node:url'],
  ];
  for (const [file, specifier, destination] of allowed)
    assert.deepEqual(
      boundaryViolations(
        root,
        join(root, file!),
        { specifier, line: 1 },
        destination ? join(root, destination) : undefined,
      ),
      [],
    );
});

function fixture(t: test.TestContext) {
  const folder = mkdtempSync(join(tmpdir(), 'atlas-boundaries-'));
  for (const directory of ['server', 'shared', 'web', 'mobile']) mkdirSync(join(folder, directory));
  t.after(() => {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    assert.ok(folder.startsWith(join(tmpdir(), 'atlas-boundaries-')));
    rmSync(folder, { recursive: true, force: true });
  });
  const put = (file: string, text = '') => {
    const path = join(folder, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  return { folder, put };
}

test('source index resolves moved TS modules and reports broken assets without scanning generated mobile resources', (t) => {
  const { folder, put } = fixture(t);
  const file = put(
    'web/page.ts',
    'import "../shared/模型.js?raw"; import "./widget"; const missing = new URL("./missing.png", import.meta.url);',
  );
  const model = put('shared/模型.ts'),
    widget = put('web/widget/index.ts');
  put('mobile/assets/generated.js', 'import "../does-not-exist";');
  assert.equal(localTarget(file, '../shared/模型.js?raw'), model);
  assert.equal(localTarget(file, './widget'), widget);
  const index = createDependencyIndex(folder),
    report = inspectBoundaries(index);
  assert.equal(report.unresolved.length, 1);
  assert.match(report.unresolved[0], /web\/page.ts:1: \.\/missing.png/);
  assert.deepEqual(report.violations, []);
  assert.equal(
    index.files.some((path: string) => path.includes('generated.js')),
    false,
  );
});

test('native graph permits adapted server reuse and detects unadapted Node services through another shim', (t) => {
  const { folder, put } = fixture(t);
  put('mobile/platform.ts', 'import "../server/service.js";');
  put('server/service.ts', 'import "node:fs";');
  const shim = put('mobile/shims/fs.ts', 'export const read = () => "";');
  const aliases = [{ find: 'node:fs', replacement: shim }];
  const valid = inspectNativeGraph(createDependencyIndex(folder), aliases);
  assert.deepEqual(valid.violations, []);
  assert.equal(valid.firstPartyFiles, 3);
  assert.deepEqual(valid.adaptedModules, ['node:fs']);
  put('mobile/shims/fs.ts', 'import "../internal.js";');
  put('mobile/internal.ts', 'import "node:fs/promises";');
  const invalid = inspectNativeGraph(createDependencyIndex(folder), aliases);
  assert.equal(invalid.violations.length, 1);
  assert.match(invalid.violations[0], /node:fs\/promises.*no mobile shim/);
  assert.ok(inspectNativeGraph(createDependencyIndex(folder), []).violations.length);
});
