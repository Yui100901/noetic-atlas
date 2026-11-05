import test, { before, after, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises';
import {
  cleanGeneratedFiles,
  checkGeneratedTracking,
  runGeneratedMaintenance,
} from '../../scripts/build/generated.mjs';

const execute = promisify(execFile);
// Node's test runner isolates this file in its own process. Disable inherited
// Git paths, global configuration and executable hooks for every subprocess.
const gitEnvironmentKeys = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_TEMPLATE_DIR',
  'GIT_CEILING_DIRECTORIES',
  ...Array.from({ length: 20 }, (_, index) => [
    `GIT_CONFIG_KEY_${index}`,
    `GIT_CONFIG_VALUE_${index}`,
  ]).flat(),
];
const inheritedGitEnvironment = new Map(
  gitEnvironmentKeys.map((name) => [name, process.env[name]]),
);
let gitIsolation: string;
before(async () => {
  gitIsolation = await mkdtemp(join(tmpdir(), 'noetic-generated-git-config-'));
  const emptyConfig = join(gitIsolation, 'empty.gitconfig');
  const emptyHooks = join(gitIsolation, 'hooks');
  await writeFile(emptyConfig, '');
  await mkdir(emptyHooks);
  for (const name of gitEnvironmentKeys) delete process.env[name];
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: emptyHooks,
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
  });
});
after(async () => {
  for (const [name, value] of inheritedGitEnvironment)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  if (gitIsolation) {
    assert.equal(dirname(resolve(gitIsolation)), resolve(tmpdir()));
    await rm(gitIsolation, { recursive: true, force: true });
  }
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'noetic-generated-maintenance-'));
  const links: string[] = [];
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    for (const link of links)
      await unlink(link).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await rm(root, { recursive: true, force: true });
  });
  const put = async (name: string, bytes: string | Buffer = name) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), bytes);
  };
  const link = async (name: string, destination: string) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    const path = join(root, name);
    await symlink(destination, path, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(path);
  };
  const git = (...args: string[]) => execute('git', args, { cwd: root, windowsHide: true });
  return { root, put, link, git };
}

async function snapshot(root: string, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory())
      for (const [child, bytes] of await snapshot(join(root, entry.name), `${name}/`))
        files.set(child, bytes);
    else files.set(name, await readFile(join(root, entry.name)));
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

const assets = ['public/fonts', 'public/pdfjs', 'mobile/assets'];
const builds = ['dist/server', 'dist/shared', 'dist/web', 'dist/mobile'];
const preserved = [
  'public/licenses/PDFjs-Apache-2.0.txt',
  'public/custom.svg',
  'web/assets/fonts/NotoSansSC-Regular.ttf',
  'web/assets/fonts/OFL-NotoSansCJK.txt',
  'data/noetic-atlas.sqlite',
  'data/release-archives/domain-packs/example.zip',
  'config/defaults.json',
  '.localtools/android-signing/release.jks',
  '.localtools/sdk/tool.exe',
  'test-results/acceptance/evidence.json',
  'artifacts/releases/software.zip',
  'artifacts/noetic-atlas-release.apk',
  'dist/apk/previous.apk',
  'android/app/src/main/java/Example.java',
  'android/app/capacitor.build.gradle',
];

async function populate(t: TestContext) {
  const context = await fixture(t);
  for (const directory of [...assets, ...builds])
    await context.put(`${directory}/old.generated`, `Generated: ${directory}`);
  for (const name of preserved) await context.put(name, `Preserve: ${name}`);
  return context;
}

async function assertPreserved(root: string) {
  for (const name of preserved)
    assert.equal(await readFile(join(root, name), 'utf8'), `Preserve: ${name}`, name);
}

test('default cleanup only previews the fixed resource directories without changing any bytes', async (t) => {
  const { root } = await populate(t);
  const before = await snapshot(root);
  const result = await cleanGeneratedFiles(root);
  assert.equal(result.mode, 'preview');
  assert.deepEqual(result.directories, assets);
  assert.deepEqual(await snapshot(root), before);
  const logs: string[] = [];
  assert.equal(
    await runGeneratedMaintenance(['clean'], {
      root,
      log: (message: string) => logs.push(message),
    }),
    true,
  );
  assert.equal(JSON.parse(logs[0]).mode, 'preview');
  assert.deepEqual(await snapshot(root), before);
});

test('asset cleanup deletes only reproducible resources and preserves source, notices, data, signing, tools and evidence', async (t) => {
  const { root } = await populate(t);
  assert.equal((await cleanGeneratedFiles(root, { apply: true })).mode, 'applied');
  for (const directory of assets)
    await assert.rejects(stat(join(root, directory)), { code: 'ENOENT' });
  for (const directory of builds)
    assert.equal(
      await readFile(join(root, directory, 'old.generated'), 'utf8'),
      `Generated: ${directory}`,
    );
  await assertPreserved(root);
});

test('build and all scopes affect exactly their declared directories and do not traverse other outputs', async (t) => {
  for (const scope of ['build', 'all'])
    await t.test(scope, async (t) => {
      const { root } = await populate(t);
      const result = await cleanGeneratedFiles(root, { scope, apply: true });
      assert.deepEqual(result.directories, scope === 'all' ? [...assets, ...builds] : builds);
      for (const directory of builds)
        await assert.rejects(stat(join(root, directory)), { code: 'ENOENT' });
      for (const directory of assets)
        if (scope === 'all') await assert.rejects(stat(join(root, directory)), { code: 'ENOENT' });
        else
          assert.equal(
            await readFile(join(root, directory, 'old.generated'), 'utf8'),
            `Generated: ${directory}`,
          );
      await assertPreserved(root);
    });
});

test('unknown or incompatible CLI options are rejected before any cleanup or generation', async (t) => {
  const { root } = await populate(t);
  const before = await snapshot(root);
  const invalid = [
    [],
    ['remove'],
    ['clean', 'public/fonts'],
    ['clean', '--unknown'],
    ['clean', '--scope', '../data', '--apply'],
    ['clean', '--target', 'web', '--apply'],
    ['clean', '--source-only', '--apply'],
    ['prepare', '--apply'],
    ['check', '--scope', 'assets'],
    ['prepare', '--source-only'],
    ['check', '--source-only', '--target', 'all'],
    ['prepare', '--target', 'other'],
  ];
  for (const args of invalid) {
    await assert.rejects(
      runGeneratedMaintenance(args, { root, log() {} }),
      undefined,
      args.join(' '),
    );
    assert.deepEqual(await snapshot(root), before, args.join(' '));
  }
  await assert.rejects(cleanGeneratedFiles(root, { scope: '../data', apply: true }), /未知.*范围/);
  assert.deepEqual(await snapshot(root), before);
});

test('a private file in the last resource directory prevents partial cleanup of earlier directories', async (t) => {
  const { root, put } = await populate(t);
  await put('mobile/assets/private.sqlite', 'private database bytes');
  const before = await snapshot(root);
  await assert.rejects(cleanGeneratedFiles(root, { apply: true }), /数据库|私密/);
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(cleanGeneratedFiles(root), /数据库|私密/);
  assert.deepEqual(await snapshot(root), before);
});

test('a junction in a late build directory prevents deletion of the entire all-scope plan', async (t) => {
  const { root, link } = await populate(t),
    outside = await fixture(t);
  await outside.put('keep.txt', 'external bytes');
  await link('dist/mobile/external', outside.root);
  await assert.rejects(cleanGeneratedFiles(root, { scope: 'all', apply: true }), /链接|联接/);
  for (const directory of [...assets, ...builds])
    assert.equal(
      await readFile(join(root, directory, 'old.generated'), 'utf8'),
      `Generated: ${directory}`,
    );
  assert.equal(await readFile(join(outside.root, 'keep.txt'), 'utf8'), 'external bytes');
  await assertPreserved(root);
});

test('independently tracked generated files are detected and cannot be deleted by cleanup', async (t) => {
  const { root, put, git } = await populate(t);
  await git('init', '--quiet', '--template=');
  await put('.gitignore', '/public/fonts/\n/mobile/assets/\n/dist/\n/android/app/build/\n');
  await put('android/app/build/generated/resource.txt', 'native generated resource');
  await put('android/capacitor.settings.gradle', 'Native scaffold intentionally tracked');
  await git(
    'add',
    '--',
    '.gitignore',
    'public/licenses/PDFjs-Apache-2.0.txt',
    'web/assets/fonts/NotoSansSC-Regular.ttf',
    'android/app/capacitor.build.gradle',
    'android/capacitor.settings.gradle',
  );
  const forbidden = [
    'public/fonts/old.generated',
    'mobile/assets/old.generated',
    'dist/web/old.generated',
    'android/app/build/generated/resource.txt',
  ];
  await git('add', '--force', '--', ...forbidden);
  const tracking = await checkGeneratedTracking(root);
  assert.equal(tracking.available, true);
  assert.deepEqual(tracking.violations.sort(), forbidden.sort());
  const before = await snapshot(root);
  await assert.rejects(cleanGeneratedFiles(root, { apply: true }), /已跟踪文件/);
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(runGeneratedMaintenance(['prepare'], { root, log() {} }), /Git.*派生资源/);
  assert.deepEqual(await snapshot(root), before);
});

test('source exports nested in a parent repository do not inspect or modify the parent Git boundary', async (t) => {
  const parent = await fixture(t);
  await parent.git('init', '--quiet', '--template=');
  await parent.put('public/fonts/parent.generated', 'parent-tracked generated file');
  await parent.git('add', '--', 'public/fonts/parent.generated');
  const root = join(parent.root, 'source-export');
  await parent.put('source-export/public/fonts/old.generated', 'child generated file');
  await parent.put('source-export/public/licenses/License.txt', 'keep legal snapshot');
  const indexBefore = await readFile(join(parent.root, '.git/index'));
  const tracking = await checkGeneratedTracking(root);
  assert.equal(tracking.available, false);
  assert.deepEqual(tracking.violations, []);
  assert.match(tracking.reason, /独立.*Git/);
  await cleanGeneratedFiles(root, { apply: true });
  await assert.rejects(stat(join(root, 'public/fonts')), { code: 'ENOENT' });
  assert.equal(
    await readFile(join(root, 'public/licenses/License.txt'), 'utf8'),
    'keep legal snapshot',
  );
  assert.equal(
    await readFile(join(parent.root, 'public/fonts/parent.generated'), 'utf8'),
    'parent-tracked generated file',
  );
  assert.deepEqual(await readFile(join(parent.root, '.git/index')), indexBefore);
});

test('source-only check validates legal snapshots without requiring any generated binary, WASM or PDF directory', async (t) => {
  const { root, put } = await fixture(t);
  const sources = {
    'PDFjs-Apache-2.0.txt': 'node_modules/pdfjs-dist/LICENSE',
    'ts-fsrs-MIT.txt': 'node_modules/ts-fsrs/LICENSE',
    'KaTeX-MIT.txt': 'node_modules/katex/LICENSE',
    'html-to-image-MIT.txt': 'node_modules/html-to-image/LICENSE',
    'fflate-MIT.txt': 'node_modules/fflate/LICENSE',
    'noble-hashes-MIT.txt': 'node_modules/@noble/hashes/LICENSE',
    'capacitor-app-MIT.txt': 'node_modules/@capacitor/app/LICENSE',
    'NotoSansCJK-OFL.txt': 'web/assets/fonts/OFL-NotoSansCJK.txt',
  };
  for (const [name, source] of Object.entries(sources)) {
    await put(source, `${name} license fixture\n`);
    await put(`public/licenses/${name}`, `${name} license fixture\n`);
  }
  const notice = '/********\n * mhchem attribution fixture\n */';
  await put('node_modules/katex/contrib/mhchem/mhchem.js', notice + '\nexport default {};');
  await put(
    'public/licenses/mhchem-NOTICE.txt',
    notice + '\nFull Apache 2.0 text: PDFjs-Apache-2.0.txt\n',
  );
  const before = await snapshot(root),
    logs: string[] = [];
  assert.equal(
    await runGeneratedMaintenance(['check', '--source-only'], {
      root,
      log: (message: string) => logs.push(message),
    }),
    true,
  );
  const report = JSON.parse(logs[0]);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.resources.map((item: { name: string }) => item.name),
    ['public/licenses'],
  );
  assert.deepEqual(await snapshot(root), before);
  for (const path of [
    'public/fonts',
    'public/pdfjs',
    'mobile/assets',
    'dist',
    'node_modules/sql.js',
    'web/assets/fonts/NotoSansSC-Regular.ttf',
  ])
    await assert.rejects(stat(join(root, path)), { code: 'ENOENT' });
  await put('public/licenses/KaTeX-MIT.txt', 'outdated snapshot');
  const staleBefore = await snapshot(root);
  assert.equal(
    await runGeneratedMaintenance(['check', '--source-only'], { root, log() {} }),
    false,
  );
  assert.deepEqual(await snapshot(root), staleBefore);
});
