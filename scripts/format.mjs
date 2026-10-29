/** Keep the refactored boundaries consistent without rewriting content catalogs or legacy code.
 * Expand format-scope.json when a module is deliberately brought into the shared style.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some((arg) => !['--check', '--write'].includes(arg)) || args.length > 1) {
  throw new Error('用法：node scripts/format.mjs [--check|--write]');
}
const files = JSON.parse(await readFile(resolve(root, 'scripts/format-scope.json'), 'utf8'));
if (
  !Array.isArray(files) ||
  !files.length ||
  files.some(
    (file) =>
      typeof file !== 'string' ||
      file.startsWith('/') ||
      file.includes('..') ||
      file.includes('\\'),
  )
) {
  throw new Error('格式化范围无效');
}
const result = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/prettier/bin/prettier.cjs'), args[0] ?? '--check', ...files],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
