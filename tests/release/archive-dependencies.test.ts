import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPackageWithOptions, extractFile, listPackage, statFile } from '@electron/asar';

test('patched desktop glob dependencies preserve Unicode, ignore rules and unpacked files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-asar-dependencies-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'input'),
    archive = join(directory, 'desktop.asar');
  await mkdir(join(source, '目录 空格'), { recursive: true });
  await writeFile(join(source, '目录 空格', '学习笔记.txt'), '离线题目与公式');
  await writeFile(join(source, 'main.cjs'), 'module.exports = 42;');
  await writeFile(join(source, 'excluded.tmp'), 'must not ship');
  // Ignore globs are relative to cwd; the OS temporary directory is outside
  // the checkout, so declare the archive source root explicitly.
  await createPackageWithOptions(source, archive, {
    unpack: '*.txt',
    globOptions: { cwd: source, ignore: ['**/*.tmp'] },
  });
  assert.ok(listPackage(archive).some((name) => name.endsWith('学习笔记.txt')));
  assert.ok(!listPackage(archive).some((name) => name.endsWith('excluded.tmp')));
  assert.equal(extractFile(archive, 'main.cjs').toString(), 'module.exports = 42;');
  assert.equal(extractFile(archive, '目录 空格/学习笔记.txt').toString(), '离线题目与公式');
  assert.equal(statFile(archive, '目录 空格/学习笔记.txt').unpacked, true);
  assert.equal(
    await readFile(join(archive + '.unpacked', '目录 空格', '学习笔记.txt'), 'utf8'),
    '离线题目与公式',
  );
});
