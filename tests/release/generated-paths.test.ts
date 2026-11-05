import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  stat,
} from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertGeneratedPath,
  ensureGeneratedDirectory,
  preflightGeneratedDirectory,
  resetGeneratedDirectory,
} from '../../scripts/build/generated-paths.mjs';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-generated-paths-'));
  const links: string[] = [];
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    for (const link of links)
      await unlink(link).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await rm(root, { recursive: true, force: true });
  });
  const put = async (name: string, value = name) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), value);
  };
  const link = async (name: string, destination: string) => {
    await mkdir(dirname(join(root, name)), { recursive: true });
    const path = join(root, name);
    await symlink(destination, path, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(path);
    return path;
  };
  return { root, put, link };
}

test('generated path validation accepts canonical owned names and rejects traversal or aliases without creating files', async (t) => {
  const { root } = await fixture(t);
  assert.equal(await assertGeneratedPath(root, 'public/fonts'), join(root, 'public/fonts'));
  for (const name of [
    '',
    '.',
    '..',
    '../outside',
    'dist/../data',
    'dist/./web',
    'dist//web',
    '/outside',
    'C:/outside',
    'dist\\web',
    'dist/name:',
    'dist/space ',
    'dist/hidden.',
    'dist/control\u0000',
    'dist/name?',
    'dist/name*',
    'dist/name|pipe',
    'dist/<name>',
    'dist/quote"',
    'dist/NUL',
    'dist/con.txt',
    'dist/AUX.log',
    'dist/COM1.cache',
    'dist/LPT\u00b2.bin',
  ]) {
    await assert.rejects(assertGeneratedPath(root, name), /生成路径/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('ensure preserves existing files, reset removes stale generated names and leaves siblings intact', async (t) => {
  const { root, put } = await fixture(t);
  await put('public/fonts/old-font.ttf.gz', 'old gzip');
  await put('public/fonts/old-hash-a.js', 'obsolete bundle');
  await put('web/assets/fonts/source.ttf', 'source font');
  await ensureGeneratedDirectory(root, 'public/fonts');
  assert.equal(await readFile(join(root, 'public/fonts/old-font.ttf.gz'), 'utf8'), 'old gzip');
  assert.equal(await resetGeneratedDirectory(root, 'public/fonts'), join(root, 'public/fonts'));
  assert.deepEqual(await readdir(join(root, 'public/fonts')), []);
  assert.equal(await readFile(join(root, 'web/assets/fonts/source.ttf'), 'utf8'), 'source font');
  await resetGeneratedDirectory(root, 'dist/mobile');
  assert.deepEqual(await readdir(join(root, 'dist/mobile')), []);
});

test('a junction at the project root, in a root ancestor or in a generated ancestor is rejected before writing', async (t) => {
  const { root, link } = await fixture(t),
    outside = await fixture(t);
  await outside.put('workspace/keep.txt', 'outside bytes');
  const rootLink = await link('root-link', outside.root);
  await assert.rejects(ensureGeneratedDirectory(rootLink, 'new/path'), /链接|联接/);
  await assert.rejects(
    ensureGeneratedDirectory(join(rootLink, 'workspace'), 'new/path'),
    /链接|联接/,
  );
  await link('public', outside.root);
  await assert.rejects(resetGeneratedDirectory(root, 'public/workspace'), /链接|联接/);
  await assert.rejects(ensureGeneratedDirectory(root, 'public/new/path'), /链接|联接/);
  assert.equal(await readFile(join(outside.root, 'workspace/keep.txt'), 'utf8'), 'outside bytes');
  await assert.rejects(stat(join(outside.root, 'new')), { code: 'ENOENT' });
});

test('an internal junction blocks the entire reset, including previously scanned regular siblings', async (t) => {
  const { root, put, link } = await fixture(t),
    outside = await fixture(t);
  await put('public/fonts/a-safe.txt', 'safe bytes');
  await outside.put('keep.txt', 'outside bytes');
  await link('public/fonts/z-external', outside.root);
  await assert.rejects(resetGeneratedDirectory(root, 'public/fonts'), /链接|联接/);
  assert.equal(await readFile(join(root, 'public/fonts/a-safe.txt'), 'utf8'), 'safe bytes');
  assert.equal(await readFile(join(outside.root, 'keep.txt'), 'utf8'), 'outside bytes');
});

test('a generated target that aliases an external or project directory is refused by every entry point', async (t) => {
  for (const external of [false, true]) {
    await t.test(external ? 'external target' : 'project target', async (t) => {
      const { root, put, link } = await fixture(t),
        outside = await fixture(t);
      const destination = external ? outside.root : join(root, 'web/assets/fonts');
      if (external) await outside.put('keep.txt', 'source bytes');
      else await put('web/assets/fonts/keep.txt', 'source bytes');
      await link('public/fonts', destination);
      for (const operation of [
        assertGeneratedPath,
        ensureGeneratedDirectory,
        preflightGeneratedDirectory,
        resetGeneratedDirectory,
      ]) {
        await assert.rejects(operation(root, 'public/fonts'), /链接|联接/);
        assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'source bytes');
      }
    });
  }
});

test('data, signing, databases and key files block deletion without partial mutation', async (t) => {
  for (const unsafe of [
    'Data/settings.json',
    'signing/password.json',
    '.git/config',
    '.localtools/tool.txt',
    'session.sqlite',
    'session.sqlite-wal',
    'session.sqlite-journal',
    'session.SQLITE3-shm',
    'session.db',
    'archive.db3',
    'private.jks',
    'private.pem',
    'private.PFX',
    'private.key',
    'backup.zip',
    'backup.7z',
    'backup.tar.gz',
    'backup.tgz',
    'backup.tar.zst',
    '.env',
    '.env.local',
    '.npmrc',
    'signing.json',
    'key.properties',
  ]) {
    await t.test(unsafe, async (t) => {
      const { root, put } = await fixture(t);
      await put('public/fonts/a-safe.txt', 'generated');
      await put('public/fonts/' + unsafe, 'private bytes');
      await assert.rejects(
        resetGeneratedDirectory(root, 'public/fonts'),
        /用户数据|签名|数据库|私钥|归档|私密|仓库|工具链/,
      );
      assert.equal(await readFile(join(root, 'public/fonts/a-safe.txt'), 'utf8'), 'generated');
      assert.equal(await readFile(join(root, 'public/fonts/' + unsafe), 'utf8'), 'private bytes');
    });
  }
});

test('read-only preflight creates no missing directory and permits all-owner validation before a reset', async (t) => {
  const { root, put } = await fixture(t);
  await put('public/fonts/old-hash.js', 'generated bytes');
  await put('public/licenses/backup.zip', 'archive bytes');
  assert.equal(await preflightGeneratedDirectory(root, 'dist/mobile'), join(root, 'dist/mobile'));
  await assert.rejects(stat(join(root, 'dist')), { code: 'ENOENT' });
  await assert.rejects(async () => {
    for (const name of ['public/fonts', 'public/licenses'])
      await preflightGeneratedDirectory(root, name);
    for (const name of ['public/fonts', 'public/licenses'])
      await resetGeneratedDirectory(root, name);
  }, /归档/);
  assert.equal(await readFile(join(root, 'public/fonts/old-hash.js'), 'utf8'), 'generated bytes');
});

test('a non-directory target or ancestor cannot be replaced by a generated directory', async (t) => {
  const { root, put } = await fixture(t);
  await put('public', 'source file');
  await assert.rejects(ensureGeneratedDirectory(root, 'public'), /已有同名文件/);
  await assert.rejects(resetGeneratedDirectory(root, 'public'), /已有同名文件/);
  await assert.rejects(assertGeneratedPath(root, 'public/fonts'), /祖先不是目录/);
  assert.equal(await readFile(join(root, 'public'), 'utf8'), 'source file');
});
