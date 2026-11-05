/** One deterministic resource plan for the web and offline Android builds.
 * Source fonts/notices stay in version control; derived binary copies do not. */
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  assertGeneratedPath,
  ensureGeneratedDirectory,
  preflightGeneratedDirectory,
  resetGeneratedDirectory,
} from './generated-paths.mjs';
import {
  validateBaseConfiguration,
  validateEmptyInstall,
} from '../release/validate-public-data.mjs';

export const licenseSources = Object.freeze({
  'PDFjs-Apache-2.0.txt': 'node_modules/pdfjs-dist/LICENSE',
  'ts-fsrs-MIT.txt': 'node_modules/ts-fsrs/LICENSE',
  'KaTeX-MIT.txt': 'node_modules/katex/LICENSE',
  'html-to-image-MIT.txt': 'node_modules/html-to-image/LICENSE',
  'fflate-MIT.txt': 'node_modules/fflate/LICENSE',
  'noble-hashes-MIT.txt': 'node_modules/@noble/hashes/LICENSE',
  'capacitor-app-MIT.txt': 'node_modules/@capacitor/app/LICENSE',
  'NotoSansCJK-OFL.txt': 'web/assets/fonts/OFL-NotoSansCJK.txt',
});
export const licenseNames = Object.freeze(
  [...Object.keys(licenseSources), 'mhchem-NOTICE.txt'].sort(),
);
export const generatedAssetDirectories = Object.freeze([
  'public/fonts',
  'public/pdfjs',
  'mobile/assets',
]);

async function sourceTree(path, prefix, files) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error(`依赖资源必须为普通目录：${path}`);
  for (const child of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = join(path, child.name),
      name = `${prefix}/${child.name}`;
    if (child.isDirectory()) await sourceTree(file, name, files);
    else if (child.isFile()) files.set(name, await readFile(file));
    else throw new Error(`依赖资源包含链接或不支持的文件：${file}`);
  }
}

/** Load and validate every source before a caller can modify any output. */
export async function createGeneratedAssetPlan(root, target = 'all') {
  if (!['all', 'web', 'mobile', 'sources'].includes(target))
    throw new Error(`未知资源目标：${target}`);
  root = resolve(root);
  const licenses = new Map();
  for (const [name, source] of Object.entries(licenseSources))
    licenses.set(name, await readFile(join(root, source)));
  const mhchem = await readFile(join(root, 'node_modules/katex/contrib/mhchem/mhchem.js'), 'utf8');
  const start = mhchem.indexOf('/********'),
    end = mhchem.indexOf('*/', start);
  if (start < 0 || end < start) throw new Error('mhchem 许可声明格式变化，请核查依赖许可');
  licenses.set(
    'mhchem-NOTICE.txt',
    Buffer.from(mhchem.slice(start, end + 2) + '\nFull Apache 2.0 text: PDFjs-Apache-2.0.txt\n'),
  );
  const plan = [];
  if (target !== 'mobile')
    plan.push({ root, name: 'public/licenses', snapshot: true, files: licenses });
  if (target === 'sources') return plan;

  // Preserve the full CJK font. AAPT expands .gz files and strips the suffix,
  // so gzip bytes intentionally use .bin and are decoded by the runtime.
  const fonts = new Map([
    [
      'NotoSansSC-Regular.ttf.bin',
      gzipSync(await readFile(join(root, 'web/assets/fonts/NotoSansSC-Regular.ttf')), { level: 9 }),
    ],
  ]);
  const pdfjs = new Map();
  for (const folder of ['cmaps', 'standard_fonts'])
    await sourceTree(join(root, 'node_modules/pdfjs-dist', folder), folder, pdfjs);
  if (target !== 'mobile') {
    plan.push({ root, name: 'public/fonts', snapshot: false, files: fonts });
    plan.push({ root, name: 'public/pdfjs', snapshot: false, files: pdfjs });
  }
  if (target !== 'web') {
    const defaults = await readFile(join(root, 'config/defaults.json'));
    validateBaseConfiguration(JSON.parse(defaults.toString('utf8')));
    validateEmptyInstall();
    const files = new Map([
      ['config/defaults.json', defaults],
      ['sql-wasm.wasm', await readFile(join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'))],
    ]);
    for (const [folder, resources] of [
      ['licenses', licenses],
      ['fonts', fonts],
      ['pdfjs', pdfjs],
    ])
      for (const [name, bytes] of resources) files.set(`${folder}/${name}`, bytes);
    plan.push({ root, name: 'mobile/assets', snapshot: false, files });
  }
  return plan;
}

async function actualTree(path, prefix = '', files = new Map(), directories = new Set()) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { files, directories };
    throw error;
  }
  for (const child of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + child.name,
      file = join(path, child.name);
    if (child.isDirectory()) {
      directories.add(name + '/');
      await actualTree(file, name + '/', files, directories);
    } else if (child.isFile()) files.set(name, await readFile(file));
    else throw new Error(`生成资源包含链接或不支持的文件：${file}`);
  }
  return { files, directories };
}

export async function inspectGeneratedAssets(plan) {
  // Check all owners before even comparing content, also protecting unchanged
  // outputs from being treated as acceptable junctions or private storage.
  for (const item of plan) await preflightGeneratedDirectory(item.root, item.name);
  const report = [];
  for (const item of plan) {
    const path = await assertGeneratedPath(item.root, item.name),
      actual = await actualTree(path);
    const expectedDirectories = new Set();
    for (const name of item.files.keys()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++)
        expectedDirectories.add(parts.slice(0, i).join('/') + '/');
    }
    const missing = [...item.files.keys()].filter((name) => !actual.files.has(name)).sort();
    const changed = [...item.files]
      .filter(([name, bytes]) => actual.files.has(name) && !bytes.equals(actual.files.get(name)))
      .map(([name]) => name)
      .sort();
    const stale = [
      ...[...actual.files.keys()].filter((name) => !item.files.has(name)),
      ...[...actual.directories].filter((name) => !expectedDirectories.has(name)),
    ].sort();
    report.push({
      name: item.name,
      missing,
      changed,
      stale,
      matches: !missing.length && !changed.length && !stale.length,
    });
  }
  return report;
}

export async function prepareGeneratedAssets(root, { target = 'all' } = {}) {
  return applyGeneratedAssetPlan(await createGeneratedAssetPlan(root, target));
}

/** Reuse a loaded plan when a build also needs to preflight its own outputs. */
export async function applyGeneratedAssetPlan(plan) {
  const report = await inspectGeneratedAssets(plan);
  for (const item of plan) {
    const result = report.find((entry) => entry.name === item.name);
    if (item.snapshot && result.stale.length)
      throw new Error(
        `许可快照目录包含未知文件，请先人工核查，未删除：${item.name}/${result.stale.join(', ')}`,
      );
  }
  for (const item of plan) {
    const result = report.find((entry) => entry.name === item.name);
    if (result.matches) {
      result.status = 'unchanged';
      continue;
    }
    if (item.snapshot) await ensureGeneratedDirectory(item.root, item.name);
    else await resetGeneratedDirectory(item.root, item.name);
    for (const [name, bytes] of item.files) {
      if (item.snapshot && !result.missing.includes(name) && !result.changed.includes(name))
        continue;
      const file = await assertGeneratedPath(item.root, `${item.name}/${name}`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes, item.snapshot ? {} : { flag: 'wx' });
    }
    result.status = 'updated';
    result.files = item.files.size;
    result.bytes = [...item.files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    // Directory creation alone carries no build-cache fingerprint. No timestamp
    // or volatile manifest is written into public/ or mobile/assets/.
  }
  return report;
}
