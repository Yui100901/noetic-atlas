/** Remove reproducible release output; retain complete, verified content archives.
 * Signing keys, installed data, toolchains and running server builds are retained.
 */
import { lstat, readdir, readFile, realpath, mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, relative, sep, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOFTWARE_DIRECTORIES = [
  'artifacts/releases', 'artifacts/github', 'artifacts/windows', 'dist/apk',
  'android/app/build', 'android/build', '.localtools/release-staging',
];
const SOFTWARE_FILES = ['artifacts/android-signing-report.json'];
const slash = path => path.replaceAll('\\', '/');
const equalPath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const databaseFile = /\.(?:sqlite(?:3)?|db(?:3)?)(?:-(?:wal|shm|journal))?$/i;
const privateKeyFile = /\.(?:keystore|jks|p12|pfx|key|pem)$/i;

async function statIfExists(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function insideRoot(root, path) {
  const name = relative(root, path);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || resolve(path) !== path || name.includes(':')) {
    throw new Error(`清理路径必须位于项目内部：${path}`);
  }
  return name;
}

/** Inspect every existing ancestor; following a junction must never authorize it. */
async function checkedPath(root, path) {
  const name = insideRoot(root, path);
  let current = root;
  for (const part of name.split(sep)) {
    current = join(current, part);
    const stat = await statIfExists(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`拒绝清理符号链接或目录联接：${current}`);
    if (!equalPath(await realpath(current), current)) throw new Error(`路径解析越界或经过链接：${current}`);
  }
  return path;
}

async function listTree(root, directory, { protectData = false, digest = false } = {}) {
  await checkedPath(root, directory);
  const files = [];
  async function visit(path) {
    // The root and its ancestors were checked above. Walk only child names and
    // lstat each entry before descending, so links are rejected without scanning
    // all ancestors again for every one of the desktop dependencies.
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`拒绝清理符号链接或目录联接：${path}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`不支持的发布文件类型：${path}`);
    if (protectData && (stat.isDirectory() && /^(?:data|signing)$/i.test(basename(path)) || stat.isFile() && (databaseFile.test(path) || privateKeyFile.test(path)))) {
      throw new Error(`发布目录中含用户数据、数据库或签名私钥，拒绝删除：${path}`);
    }
    const name = slash(relative(directory, path));
    if (stat.isDirectory()) {
      files.push({ name, type: 'directory' });
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else {
      const entry = { name, type: 'file', bytes: stat.size };
      if (digest) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        entry.sha256 = hash.digest('hex');
      }
      files.push(entry);
    }
  }
  await visit(directory);
  return files;
}

function gitTrackedFiles(root) {
  const probe = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', windowsHide: true });
  if (probe.error) throw new Error(`无法检查 Git 跟踪情况：${probe.error.message}`);
  if (probe.status !== 0) {
    // A standalone exported source directory need not have a Git repository.
    if (/not a git repository/i.test(probe.stderr || '')) return [];
    throw new Error(`无法检查 Git 工作区：${probe.stderr}`);
  }
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--full-name'], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const top = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || top.status !== 0) throw new Error(`无法读取 Git 跟踪文件：${result.stderr || top.stderr}`);
  return result.stdout.split('\0').filter(Boolean).map(name => resolve(top.stdout.trim(), name));
}

function refuseTracked(root, path, tracked) {
  const prefix = path + sep;
  if (tracked.some(file => equalPath(file, path) || (process.platform === 'win32' ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix)))) {
    throw new Error(`拒绝清理 Git 已跟踪文件：${slash(relative(root, path))}`);
  }
}

function identical(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function summary(manifest) {
  const files = manifest.filter(entry => entry.type === 'file');
  return { files: files.length, bytes: files.reduce((total, entry) => total + entry.bytes, 0) };
}

export async function cleanupReleaseArtifacts({ root = resolve(import.meta.dirname, '../..'), dryRun = false } = {}) {
  const requestedRoot = resolve(root);
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error('项目根目录不能为符号链接或目录联接');
  root = await realpath(requestedRoot);
  const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (project.name !== 'noetic-atlas') throw new Error('清理命令只适用于 noetic-atlas 项目根目录');
  const tracked = gitTrackedFiles(root);
  const source = join(root, 'artifacts/domain-packs');
  const destination = join(root, 'data/release-archives/domain-packs');
  const archives = [], removals = [];

  // Fully preflight everything before any move or deletion, including collisions.
  await checkedPath(root, source);
  await checkedPath(root, destination);
  if (await statIfExists(source)) {
    if (!(await lstat(source)).isDirectory()) throw new Error('领域题库产物必须是目录');
    refuseTracked(root, source, tracked);
    for (const name of (await readdir(source)).sort()) {
      const from = join(source, name), to = join(destination, name);
      const manifest = await listTree(root, from, { digest: true });
      await checkedPath(root, to);
      refuseTracked(root, to, tracked);
      const existing = await statIfExists(to);
      if (existing && !identical(manifest, await listTree(root, to, { digest: true }))) {
        throw new Error(`领域题库归档冲突；源数据和现有归档均已保留：${slash(relative(root, to))}`);
      }
      archives.push({ from, to, manifest, deduplicated: !!existing, ...summary(manifest) });
    }
  }
  const candidates = [...SOFTWARE_DIRECTORIES, ...SOFTWARE_FILES];
  await checkedPath(root, join(root, 'artifacts'));
  if (await statIfExists(join(root, 'artifacts'))) {
    for (const name of await readdir(join(root, 'artifacts'))) {
      if (/^noetic-atlas[^/\\]*\.apk(?:\.idsig)?$/i.test(name)) candidates.push(`artifacts/${name}`);
    }
  }
  for (const name of candidates) {
    const path = await checkedPath(root, join(root, name));
    if (!await statIfExists(path)) continue;
    refuseTracked(root, path, tracked);
    const manifest = await listTree(root, path, { protectData: true });
    removals.push({ path, ...summary(manifest) });
  }

  if (!dryRun) {
    for (const archive of archives) {
      await checkedPath(root, archive.from);
      await checkedPath(root, archive.to);
      refuseTracked(root, archive.from, gitTrackedFiles(root));
      // Re-hash before mutation in case a background exporter changed the source.
      if (!identical(archive.manifest, await listTree(root, archive.from, { digest: true }))) throw new Error('归档期间源题库发生更改，已停止清理');
      if (archive.deduplicated) {
        if (!identical(archive.manifest, await listTree(root, archive.to, { digest: true }))) throw new Error('归档期间目标题库发生更改，已停止清理');
        await rm(archive.from, { recursive: true, force: false });
      } else {
        await mkdir(dirname(archive.to), { recursive: true });
        await checkedPath(root, archive.to);
        if (await statIfExists(archive.to)) throw new Error('归档目标在操作期间被创建，拒绝覆盖');
        // Same project volume: rename preserves every byte and complete metadata.
        await rename(archive.from, archive.to);
        if (!identical(archive.manifest, await listTree(root, archive.to, { digest: true }))) throw new Error('题库归档后摘要校验失败；已保留归档，停止清理');
      }
    }
    if (await statIfExists(source)) {
      await checkedPath(root, source);
      if ((await readdir(source)).length === 0) await rmdir(source);
    }
    for (const removal of removals) {
      await checkedPath(root, removal.path);
      refuseTracked(root, removal.path, gitTrackedFiles(root));
      await listTree(root, removal.path, { protectData: true });
      await rm(removal.path, { recursive: true, force: false });
    }
  }
  return {
    dryRun,
    archived: archives.map(({ from, to, deduplicated, files, bytes }) => ({ from: slash(relative(root, from)), to: slash(relative(root, to)), deduplicated, files, bytes })),
    removed: removals.map(({ path, files, bytes }) => ({ path: slash(relative(root, path)), files, bytes })),
    removedBytes: removals.reduce((total, item) => total + item.bytes, 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run')) { console.error('用法：node scripts/release/cleanup.mjs [--dry-run]'); process.exitCode = 1; }
  else cleanupReleaseArtifacts({ dryRun: args.includes('--dry-run') }).then(report => {
    console.log(JSON.stringify(report, null, 2));
  }).catch(error => { console.error(`发布产物清理中止：${error.message}`); process.exitCode = 1; });
}
