/** Discover grouped tests without relying on shell-specific glob expansion. */
import { readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(file));
    else if (entry.name.endsWith('.test.ts')) files.push(file);
  }
  return files;
}
const files = (await discover(resolve(root, 'tests'))).sort();
if (!files.length) throw new Error('没有找到测试文件');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit', windowsHide: true });
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
