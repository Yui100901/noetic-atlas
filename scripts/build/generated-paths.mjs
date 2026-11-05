/** Filesystem boundary for explicitly owned, reproducible build directories.
 * The caller selects ownership from a fixed catalog; this helper does not turn
 * arbitrary project paths into safe cleanup targets. */
import { lstat, realpath, readdir, mkdir, rm } from 'node:fs/promises';
import { resolve, relative, join, sep, isAbsolute, basename } from 'node:path';

const equalPath = (left, right) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const protectedFile =
  /\.(?:sqlite(?:3)?|db(?:3)?)(?:-(?:wal|shm|journal))?$|\.(?:keystore|jks|p12|pfx|key|pem|zip|7z|rar|tgz|tbz2?|txz|tar(?:\.(?:gz|bz2|xz|zst))?)$/i;
const protectedConfiguration =
  /^(?:\.env(?:\..*)?|\.npmrc|signing\.json|google-services\.json|key\.properties|keystore\.properties|signing\.properties|passwords?\.json)$/i;
const protectedDirectory = /^(?:data|signing|\.git|\.localtools)$/i;
// Keep catalog names portable across the release hosts; Windows also treats
// these names with extensions (for example NUL.txt) as device aliases.
const reservedWindowsName =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;

async function statIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Reject aliases before resolving them: lexical containment alone is not
 * sufficient when an existing ancestor is a Windows junction. */
export async function assertGeneratedPath(root, name) {
  if (
    typeof name !== 'string' ||
    !name ||
    isAbsolute(name) ||
    /[\\:<>"|?*\u0000-\u001f\u007f]/.test(name) ||
    name
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.trim() !== part ||
          part.endsWith('.') ||
          reservedWindowsName.test(part),
      )
  ) {
    throw new Error('生成路径必须是规范的项目内相对路径');
  }
  root = resolve(root);
  const rootStat = await lstat(root);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    !equalPath(await realpath(root), root)
  ) {
    throw new Error('生成目录的项目根路径不能包含符号链接或目录联接');
  }
  const target = resolve(root, ...name.split('/'));
  const child = relative(root, target);
  if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) {
    throw new Error('生成路径必须位于项目内部且不能为项目根目录');
  }
  let current = root;
  for (const [index, part] of name.split('/').entries()) {
    current = join(current, part);
    const entry = await statIfExists(current);
    if (!entry) break;
    if (entry.isSymbolicLink() || !equalPath(await realpath(current), current)) {
      throw new Error(`生成路径包含符号链接或目录联接：${name}`);
    }
    if (current !== target && !entry.isDirectory()) {
      throw new Error(
        `生成路径的祖先不是目录：${name
          .split('/')
          .slice(0, index + 1)
          .join('/')}`,
      );
    }
  }
  return target;
}

/** Ensure is non-destructive; existing generated files are left untouched. */
export async function ensureGeneratedDirectory(root, name) {
  const target = await assertGeneratedPath(root, name);
  const entry = await statIfExists(target);
  if (entry && !entry.isDirectory()) throw new Error(`生成目录已有同名文件：${name}`);
  await mkdir(target, { recursive: true });
  await assertGeneratedPath(root, name);
  return target;
}

async function preflightTree(path) {
  const entry = await statIfExists(path);
  if (!entry) return;
  if (entry.isSymbolicLink() || !equalPath(await realpath(path), path))
    throw new Error(`生成目录内含符号链接或目录联接，拒绝清理：${path}`);
  if (!entry.isDirectory() && !entry.isFile())
    throw new Error(`生成目录内含不支持的文件类型：${path}`);
  if (entry.isDirectory()) {
    if (protectedDirectory.test(basename(path)))
      throw new Error(`生成目录内含用户数据、签名、仓库或工具链目录，拒绝清理：${path}`);
    for (const child of (await readdir(path)).sort()) await preflightTree(join(path, child));
  } else if (protectedFile.test(basename(path)) || protectedConfiguration.test(basename(path))) {
    throw new Error(`生成目录内含数据库、归档或私密配置，拒绝清理：${path}`);
  }
}

/** Read-only preflight supports validating an entire fixed owner catalog before
 * a caller performs the first write or deletion in a multi-directory build. */
export async function preflightGeneratedDirectory(root, name) {
  const target = await assertGeneratedPath(root, name);
  const entry = await statIfExists(target);
  if (entry && !entry.isDirectory()) throw new Error(`生成目录已有同名文件：${name}`);
  await preflightTree(target);
  return target;
}

/** Preflight the complete tree before the first deletion, then revalidate the
 * target's ancestors immediately before removing this one owned directory. */
export async function resetGeneratedDirectory(root, name) {
  const target = await preflightGeneratedDirectory(root, name);
  await assertGeneratedPath(root, name);
  await rm(target, { recursive: true, force: true });
  return ensureGeneratedDirectory(root, name);
}
