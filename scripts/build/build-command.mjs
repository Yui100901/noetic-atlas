/** Shared command helpers. Importing a build helper must not load the release CLI. */
import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export function formatCommand(command, args) {
  const quote = value => /[\s"']/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  return [command, ...args].map(quote).join(' ');
}

export function findNpmCli({ env = process.env, node = process.execPath, platform = process.platform } = {}) {
  const pathCandidates = (env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map(directory => resolve(directory, platform === 'win32' ? 'npm.cmd' : 'npm'));
  const resolvedNpm = pathCandidates.flatMap(path => { try { return [realpathSync(path)]; } catch { return []; } });
  const candidate = [env.npm_execpath, resolve(dirname(node), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'), ...resolvedNpm.filter(path => path.endsWith('npm-cli.js'))].find(path => path && existsSync(path));
  if (!candidate) throw new Error('无法定位 npm；请通过 npm run release -- <目标> 执行');
  return candidate;
}
