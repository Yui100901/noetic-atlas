import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(
  import.meta.dirname || dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const inputs = [
  'server',
  'shared',
  'web',
  'public',
  'docs/使用说明书.md',
  'docs/题库内容与来源.md',
  'docs/题目字段与质量规则.md',
  'docs/术语概念卡.md',
  'docs/发布与部署.md',
  'docs/API-CONTRACT.md',
  'docs/licenses',
  'README.md',
  'config/defaults.json',
  'package.json',
  'package-lock.json',
  'tsconfig.server.json',
  'tsconfig.web.json',
  'tsconfig.json',
  'vite.config.ts',
  'scripts/build',
];
const entries = ['dist/server/main.js', 'dist/web/index.html'];
const cacheFile = 'dist/.startup-cache.json';
/** Content hashes ignore timestamps and never scan data, credentials or backups. */
export function treeFingerprint(root, paths, previous = []) {
  const hash = createHash('sha256');
  let files = 0;
  const known = new Map(previous.map((row) => [row.path, row])),
    records = [];
  const walk = (file, entry) => {
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) {
      hash.update(JSON.stringify([file, 'missing']));
      return;
    }
    entry ||= lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new Error('构建目录包含符号链接，请先核对目录后手动构建');
    if (entry.isDirectory()) {
      for (const child of readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name, 'en'),
      ))
        walk(join(file, child.name), child);
      return;
    }

    const path = file.replaceAll('\\', '/'),
      stat = lstatSync(absolute),
      prior = known.get(path);
    const digest =
      prior &&
      prior.size === stat.size &&
      prior.mtime === stat.mtimeMs &&
      prior.ctime === stat.ctimeMs
        ? prior.hash
        : createHash('sha256').update(readFileSync(absolute)).digest('hex');
    const record = {
      path,
      size: stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      hash: digest,
    };
    records.push(record);
    hash.update(JSON.stringify([path, digest]));
    files++;
  };
  for (const path of paths) walk(path);
  return { hash: hash.digest('hex'), files, records };
}
export function buildState(root = projectRoot, { sources = true } = {}) {
  const missing = entries.filter((p) => !existsSync(resolve(root, p)));
  let saved;
  try {
    saved = JSON.parse(readFileSync(resolve(root, cacheFile), 'utf8'));
  } catch {}
  if (missing.length) return { fresh: false, ready: false, reason: '缺少构建产物', missing };
  if (!saved || saved.version !== 2)
    return { fresh: false, ready: false, reason: '尚未记录成功构建，请先构建一次' };
  const output = treeFingerprint(root, ['dist/server', 'dist/web'], saved.outputFiles);
  if (saved.output !== output.hash)
    return { fresh: false, ready: false, reason: '构建产物已变化或不完整' };
  if (!sources)
    return {
      fresh: false,
      ready: true,
      reason: '仅核对上次成功构建，不检查源码更新',
      builtAt: saved.builtAt,
    };
  const input = treeFingerprint(root, inputs, saved.inputFiles);
  return {
    fresh: input.hash === saved.input,
    ready: true,
    reason: input.hash === saved.input ? '源码未变化，复用已有构建' : '源码或依赖锁已变化',
    builtAt: saved.builtAt,
  };
}
export function recordBuild(root = projectRoot) {
  if (entries.some((p) => !existsSync(resolve(root, p))))
    throw new Error('构建未完成，不能记录快速启动缓存');
  const input = treeFingerprint(root, inputs),
    output = treeFingerprint(root, ['dist/server', 'dist/web']);
  const saved = {
    version: 2,
    builtAt: new Date().toISOString(),
    input: input.hash,
    output: output.hash,
    inputFiles: input.records,
    outputFiles: output.records,
  };
  const file = resolve(root, cacheFile);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(saved));
  renameSync(file + '.tmp', file);
  return saved;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) recordBuild();
