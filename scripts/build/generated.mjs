/** Explicit generated-file maintenance. No user data, keys, toolchains or
 * acceptance evidence are owned here; release cleanup is a separate tool. */
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rmdir } from 'node:fs/promises';
import {
  createGeneratedAssetPlan,
  inspectGeneratedAssets,
  prepareGeneratedAssets,
  generatedAssetDirectories,
} from './generated-assets.mjs';
import { preflightGeneratedDirectory, resetGeneratedDirectory } from './generated-paths.mjs';

const execute = promisify(execFile);
export const buildDirectories = Object.freeze([
  'dist/server',
  'dist/shared',
  'dist/web',
  'dist/mobile',
]);
const samePath = (left, right) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

/** Source exports may live inside somebody else's repository. Never use the
 * enclosing repository as if it were this project's source boundary. */
export async function checkGeneratedTracking(root) {
  let top;
  try {
    top = (
      await execute('git', ['rev-parse', '--show-toplevel'], { cwd: root, windowsHide: true })
    ).stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 128)
      return { available: false, reason: '当前目录无独立 Git 仓库', violations: [] };
    throw error;
  }
  if (!samePath(resolve(top), resolve(root)))
    return { available: false, reason: '当前源码未建立独立 Git 仓库', violations: [] };
  const { stdout } = await execute('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const forbidden =
    /^(?:dist\/|mobile\/assets\/|public\/(?:fonts|pdfjs)\/|android\/(?:(?:build|\.gradle|\.kotlin|\.cxx|\.externalNativeBuild)\/|[^\0]*\/build\/|capacitor-cordova-android-plugins\/|app\/src\/main\/assets\/(?:public\/|capacitor\.)))/i;
  return {
    available: true,
    violations: stdout.split('\0').filter((file) => file && forbidden.test(file)),
  };
}

export async function cleanGeneratedFiles(root, { scope = 'assets', apply = false } = {}) {
  if (!['assets', 'build', 'all'].includes(scope)) throw new Error(`未知清理范围：${scope}`);
  const names = [
    ...(scope !== 'build' ? generatedAssetDirectories : []),
    ...(scope !== 'assets' ? buildDirectories : []),
  ];
  // All-owner preflight prevents a late discovery in a second directory from
  // leaving the first directory partially removed.
  for (const name of names) await preflightGeneratedDirectory(root, name);
  const tracking = await checkGeneratedTracking(root);
  if (tracking.violations.length)
    throw new Error(`生成目录中存在已跟踪文件，拒绝清理：${tracking.violations.join(', ')}`);
  if (apply) {
    for (const name of names) {
      const path = await resetGeneratedDirectory(root, name);
      await rmdir(path);
    }
  }
  return { mode: apply ? 'applied' : 'preview', directories: names, tracking };
}

export async function runGeneratedMaintenance(
  args,
  { root = resolve(import.meta.dirname, '../..'), log = console.log } = {},
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      target: { type: 'string' },
      scope: { type: 'string' },
      apply: { type: 'boolean' },
      'source-only': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    log(
      'generated.mjs prepare [--target all|web|mobile]\n  check [--target all|web|mobile | --source-only]\n  clean [--scope assets|build|all] [--apply]\n清理默认为预览。许可证快照、数据、签名、工具链、验收证据和发布包均不清理。',
    );
    return true;
  }
  const [command] = positionals;
  if (positionals.length !== 1 || !['prepare', 'check', 'clean'].includes(command))
    throw new Error('请指定 prepare、check 或 clean；--help 查看用法');
  if (command !== 'clean' && (values.scope !== undefined || values.apply !== undefined))
    throw new Error('--scope/--apply 仅用于 clean');
  if (command !== 'check' && values['source-only'] !== undefined)
    throw new Error('--source-only 仅用于 check');
  if (command === 'clean' && (values.target !== undefined || values['source-only'] !== undefined))
    throw new Error('clean 仅接受 --scope/--apply');
  if (values['source-only'] && values.target !== undefined)
    throw new Error('--source-only 不与 --target 同用');
  if (values.target !== undefined && !['all', 'web', 'mobile'].includes(values.target))
    throw new Error(`未知资源目标：${values.target}`);
  if (command === 'clean') {
    log(
      JSON.stringify(
        await cleanGeneratedFiles(root, { scope: values.scope, apply: values.apply }),
        null,
        2,
      ),
    );
    return true;
  }
  const tracking = await checkGeneratedTracking(root);
  if (tracking.violations.length)
    throw new Error(`Git 中混入派生资源：${tracking.violations.join(', ')}`);
  if (command === 'prepare') {
    const resources = await prepareGeneratedAssets(root, { target: values.target });
    log(JSON.stringify({ command, resources, tracking }, null, 2));
    return true;
  }
  const resources = await inspectGeneratedAssets(
    await createGeneratedAssetPlan(root, values['source-only'] ? 'sources' : values.target),
  );
  const ok = resources.every((item) => item.matches);
  log(JSON.stringify({ command, ok, resources, tracking }, null, 2));
  if (!ok)
    log('资源缺失、过期或含旧文件。运行 npm run generated:prepare；未知许可证请先人工核查。');
  return ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!(await runGeneratedMaintenance(process.argv.slice(2)))) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
