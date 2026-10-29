/** Version metadata only: never invokes npm version, hooks, Git or a build. */
import { readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const pattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;
export function normalizeReleaseVersion(value) {
  if (typeof value !== 'string') throw new Error('版本号须为 x.y 或 x.y.z，可附 -rc.1 等预发布段');
  const version = value.trim().replace(/^[vV]/, ''),
    match = pattern.exec(version);
  if (
    !match ||
    match.slice(1, 4).some((part) => part !== undefined && !Number.isSafeInteger(Number(part))) ||
    match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')
  ) {
    throw new Error('版本号须为 x.y 或 x.y.z，可附 -rc.1 等预发布段；不支持前导零或 +build 元数据');
  }
  return version;
}

export function androidVersionCode(value) {
  const version = normalizeReleaseVersion(value),
    [major, minor, patch = 0] = version.split('-')[0].split('.').map(Number);
  if (minor >= 100 || patch >= 100) throw new Error('Android 版本的 minor/patch 必须小于100');
  const code = major * 10000 + minor * 100 + patch;
  if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000)
    throw new Error('Android versionCode 必须为1–2100000000');
  return code;
}

export function validateReleaseVersion(value, target) {
  const version = normalizeReleaseVersion(value);
  if (target === 'android' || target === 'all') androidVersionCode(version);
  return version;
}

export function expectedReleaseArtifacts(target, value) {
  const version = validateReleaseVersion(value, target),
    prefix = `noetic-atlas-${version}`;
  const targets = target === 'all' ? ['web', 'windows', 'android', 'docker'] : [target];
  return targets.flatMap((item) =>
    item === 'web'
      ? [`${prefix}-source.zip`, `${prefix}-runtime.zip`]
      : item === 'source'
        ? [`${prefix}-source.zip`]
        : item === 'windows'
          ? [`${prefix}-windows-x64.zip`]
          : item === 'android'
            ? [`${prefix}-android.apk`]
            : item === 'docker'
              ? [`noetic-atlas:${version}`]
              : [],
  );
}

export async function readProjectVersion(root) {
  const value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (value.name !== 'noetic-atlas') throw new Error('项目名无效');
  return normalizeReleaseVersion(value.version);
}

export async function selectReleaseVersion(
  options,
  {
    root = resolve(import.meta.dirname, '../..'),
    currentVersion,
    input = process.stdin,
    output = process.stdout,
    isTTY = process.stdin.isTTY,
  } = {},
) {
  if (options.target === 'clean' || options.help) return options;
  const current = currentVersion ?? (await readProjectVersion(root));
  if (options.version)
    return { ...options, version: validateReleaseVersion(options.version, options.target) };
  if (!isTTY) return { ...options, version: validateReleaseVersion(current, options.target) };
  const reader = createInterface({ input, output });
  try {
    const answer = (await reader.question(`发布版本 [${current}]（回车保留当前版本）：`)).trim();
    return { ...options, version: validateReleaseVersion(answer || current, options.target) };
  } finally {
    reader.close();
  }
}

// Locate JSON value spans instead of reserializing a lockfile. Only the three
// version strings change; indentation, line endings and every other byte stay.
function valueAt(text, path) {
  const space = (offset) => {
    while (/\s/.test(text[offset] || '') && offset < text.length) offset++;
    return offset;
  };
  const stringEnd = (start) => {
    let offset = start + 1;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset++] === '"') return offset;
    }
    throw new Error('JSON字符串未闭合');
  };
  const valueEnd = (start) => {
    if (text[start] === '"') return stringEnd(start);
    if (text[start] === '{' || text[start] === '[') {
      let depth = 0,
        offset = start;
      do {
        const token = text[offset];
        if (token === '"') {
          offset = stringEnd(offset);
          continue;
        }
        if (token === '{' || token === '[') depth++;
        if (token === '}' || token === ']') depth--;
        offset++;
      } while (depth && offset < text.length);
      return offset;
    }
    let offset = start;
    while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset++;
    return offset;
  };
  let object = space(0);
  for (let index = 0; index < path.length; index++) {
    if (text[object] !== '{') throw new Error(`版本字段缺失：${path.join('.')}`);
    let offset = space(object + 1),
      found;
    while (text[offset] !== '}' && offset < text.length) {
      const end = stringEnd(offset),
        key = JSON.parse(text.slice(offset, end));
      const start = space(space(end) + 1),
        finish = valueEnd(start);
      if (key === path[index]) {
        if (found) throw new Error('版本元数据含重复字段');
        found = { start, end: finish };
      }
      offset = space(finish);
      if (text[offset] === ',') offset = space(offset + 1);
    }
    if (!found) throw new Error(`版本字段缺失：${path.join('.')}`);
    if (index === path.length - 1) return found;
    object = found.start;
  }
}

function replaceVersion(text, paths, version) {
  JSON.parse(text.replace(/^\uFEFF/, ''));
  const spans = paths.map((path) => valueAt(text, path)).sort((a, b) => b.start - a.start);
  for (const span of spans) {
    if (typeof JSON.parse(text.slice(span.start, span.end)) !== 'string')
      throw new Error('版本字段必须为字符串');
    text = text.slice(0, span.start) + JSON.stringify(version) + text.slice(span.end);
  }
  return text;
}

/** Prepare both files before replacing either. Partial filesystem failures roll
 * back already replaced metadata; rollback refuses to overwrite later edits. */
export async function syncReleaseVersion(
  root,
  value,
  { fileSystem = { readFile, writeFile, rename, rm, lstat } } = {},
) {
  root = resolve(root);
  const version = normalizeReleaseVersion(value),
    records = [];
  for (const [name, paths] of [
    ['package.json', [['version']]],
    ['package-lock.json', [['version'], ['packages', '', 'version']]],
  ]) {
    const path = join(root, name),
      info = await fileSystem.lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`版本元数据必须是普通文件：${name}`);
    const original = await fileSystem.readFile(path, 'utf8'),
      json = JSON.parse(original.replace(/^\uFEFF/, ''));
    if (
      json.name !== 'noetic-atlas' ||
      (name === 'package-lock.json' &&
        (!json.packages?.[''] ||
          (json.packages[''].name !== undefined && json.packages[''].name !== 'noetic-atlas')))
    )
      throw new Error(`项目版本元数据无效：${name}`);
    const updated = replaceVersion(original, paths, version);
    records.push({ path, original, updated, mode: info.mode, changed: original !== updated });
  }
  const previousVersion = JSON.parse(records[0].original.replace(/^\uFEFF/, '')).version;
  const staged = [],
    committed = [];
  const replace = async (record, text) => {
    const temporary = join(
      dirname(record.path),
      `.${basename(record.path)}.release-version-${randomUUID()}.tmp`,
    );
    staged.push(temporary);
    await fileSystem.writeFile(temporary, text, { flag: 'wx', mode: record.mode });
    await fileSystem.rename(temporary, record.path);
  };
  const restore = async () => {
    const errors = [];
    for (const record of [...committed].reverse()) {
      try {
        if ((await fileSystem.readFile(record.path, 'utf8')) !== record.updated)
          throw new Error('文件已被其他操作修改，未覆盖');
        await replace(record, record.original);
      } catch (error) {
        errors.push(`${basename(record.path)}：${error.message}`);
      }
    }
    if (errors.length) throw new Error(`版本回滚未完全完成：${errors.join('；')}`);
  };
  try {
    for (const record of records.filter((item) => item.changed)) {
      if ((await fileSystem.readFile(record.path, 'utf8')) !== record.original)
        throw new Error('版本元数据在预检后发生变化，请重试');
      await replace(record, record.updated);
      committed.push(record);
    }
  } catch (error) {
    try {
      await restore();
    } catch (rollback) {
      throw new AggregateError([error, rollback], `${error.message}；${rollback.message}`);
    }
    throw error;
  } finally {
    for (const path of staged) await fileSystem.rm(path, { force: true }).catch(() => undefined);
  }
  return {
    version,
    previousVersion,
    changed: committed.length > 0,
    rollback: async () => {
      try {
        await restore();
      } finally {
        for (const path of staged)
          await fileSystem.rm(path, { force: true }).catch(() => undefined);
      }
    },
  };
}
