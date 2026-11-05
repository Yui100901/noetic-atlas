import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const project = resolve(import.meta.dirname, '../..');

test('fresh Windows checkout keeps generated license snapshots and font source notices byte-identical', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'noetic-generated-line-endings-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const emptyConfig = join(root, 'empty.gitconfig'),
    emptyHooks = join(root, 'hooks');
  await writeFile(emptyConfig, '');
  await mkdir(emptyHooks);
  // Exercise the real source attributes, while isolating Git from inherited
  // indexes, repositories, global filters and executable monitor/hook config.
  await writeFile(join(root, '.gitattributes'), await readFile(join(project, '.gitattributes')));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')),
  );
  const git = (...args: string[]) =>
    execute(
      'git',
      [
        '-c',
        'core.autocrlf=true',
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${emptyHooks}`,
        ...args,
      ],
      {
        cwd: root,
        windowsHide: true,
        encoding: 'buffer',
        env: {
          ...environment,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: emptyConfig,
          GIT_CONFIG_SYSTEM: emptyConfig,
        },
      },
    );
  await git('init', '--quiet', '--template=');
  const sourceFiles = [
    'public/licenses/KaTeX-MIT.txt',
    'public/licenses/mhchem-NOTICE.txt',
    'web/assets/fonts/OFL-NotoSansCJK.txt',
  ];
  for (const name of sourceFiles) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    const source = await readFile(join(project, name));
    assert.equal(source.includes(Buffer.from('\r\n')), false, `${name}: source must use LF`);
    await writeFile(path, source);
  }
  // An index-only fixture avoids commits, signing requirements or changing the
  // working repository. --filters models the bytes produced by checkout.
  await git('add', '--', '.gitattributes', ...sourceFiles);
  for (const name of sourceFiles) {
    const filtered = await git('cat-file', '--filters', `:${name}`);
    assert.deepEqual(filtered.stdout, await readFile(join(project, name)), name);
    assert.equal(filtered.stdout.includes(Buffer.from('\r\n')), false, name);
    const attribute = await git('check-attr', '-z', 'eol', '--', name);
    assert.deepEqual(attribute.stdout.toString('utf8').split('\0'), [name, 'eol', 'lf', '']);
  }
});
