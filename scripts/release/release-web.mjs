/** Allowlisted, reproducible source/runtime ZIPs. Never package a working database. */
import { readFile, readdir, mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { normalizeReleaseVersion } from './version.mjs';
import { validateEmptyInstall, validateBaseConfiguration } from './validate-public-data.mjs';

const excluded =
  /^(?:mobile\/assets|public\/pdfjs|android\/app\/src\/main\/assets|android\/capacitor-cordova-android-plugins)(?:\/|$)|^android\/(?:[^/]+\/)*build(?:\/|$)|^android\/app\/src\/main\/res\/xml\/config\.xml$|(?:^|\/)(?:node_modules|\.gradle|\.idea|\.vscode|\.localtools|\.cache|\.kotlin|\.cxx|\.externalNativeBuild|__pycache__|screenshots|release-staging|artifacts|test-results|coverage)(?:\/|$)|(?:^|\/)(?:local\.properties|key\.properties|signing\.json|\.npmrc|\.env[^/]*|google-services\.json)$|\.(?:sqlite3?(?:-[\w]+)?|db(?:-[\w]+)?|keystore|jks|p12|pfx|pem|key|log|apk|aab|aar|dex|class|py[cod]|tsbuildinfo)$/i;
// Defense in depth: even a future broad `data` input must not include runtime
// JSON configuration, backups, browser profiles or separately licensed packs.
export function isSoftwareReleaseDataPath(name) {
  if (/^data(?:\/|$)/i.test(name)) return false;
  return !/^config(?:\/|$)/i.test(name) || name === 'config' || name === 'config/defaults.json';
}
export const SOFTWARE_DATA_BOUNDARY = Object.freeze({
  installation: 'empty-install',
  includesQuestionData: false,
  baseConfiguration: 'config/defaults.json',
  expandedBanks: 'separate-content-release',
  includesUserData: false,
  includesUserConfiguration: false,
});
export async function collectReleaseFiles(root, paths) {
  root = await realpath(root);
  const files = [];
  async function visit(path) {
    const name = relative(root, path).replaceAll('\\', '/');
    if (excluded.test(name) || !isSoftwareReleaseDataPath(name)) return;
    const actual = await realpath(path);
    if (actual !== root && !actual.startsWith(root + sep))
      throw new Error(`发布路径越出项目目录：${name}`);
    const actualName = relative(root, actual).replaceAll('\\', '/');
    if (excluded.test(actualName) || !isSoftwareReleaseDataPath(actualName))
      throw new Error(`发布路径引用了受限本地文件：${name}`);
    const info = await stat(path);
    if (info.isDirectory())
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    else files.push({ name, data: await readFile(path) });
  }
  for (const path of paths) await visit(resolve(root, path));
  for (const file of files)
    if (
      file.name === 'Dockerfile' ||
      /\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|xml|gradle|ps1|cmd|sh|properties|java|html|css)$/.test(
        file.name,
      )
    ) {
      const content = file.data.toString('utf8');
      if (/sk-[A-Za-z0-9]{20,}|[A-Z]:[\\/]+Users[\\/]+[^\\/"\s]+/i.test(content))
        throw new Error(`发布文件包含本机私有信息：${file.name}`);
    }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (data) => {
  let crc = 0xffffffff;
  for (const n of data) crc = crcTable[(crc ^ n) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
export function createZip(files, prefix) {
  const entries = [],
    directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(`${prefix}/${file.name}`),
      compressed = deflateRawSync(file.data),
      crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    entries.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = /(?:^|\/)(?:gradlew|[^/]+\.sh)$/.test(file.name) ? 0o100755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, central, end]);
}
export async function packageWebRelease({
  root = resolve(import.meta.dirname, '../..'),
  onlySource = false,
} = {}) {
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'noetic-atlas') throw new Error('项目名或版本无效');
  const version = normalizeReleaseVersion(packageJson.version);
  const counts = validateEmptyInstall();
  validateBaseConfiguration(
    JSON.parse(await readFile(resolve(root, 'config/defaults.json'), 'utf8')),
  );
  const legalFiles = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md'].filter(
    (name) => existsSync(resolve(root, name)),
  );
  const developmentFiles = ['.prettierrc.json', '.prettierignore', '.github'].filter((name) =>
    existsSync(resolve(root, name)),
  );
  const common = [
    'package.json',
    'package-lock.json',
    'README.md',
    'docs',
    'config/defaults.json',
    ...legalFiles,
  ];
  const source = await collectReleaseFiles(root, [
    ...common,
    ...developmentFiles,
    'Dockerfile',
    'compose.yaml',
    'server',
    'shared',
    'web',
    'mobile',
    'android',
    'desktop',
    'scripts',
    'public',
    'index.html',
    'capacitor.config.ts',
    'tsconfig.server.json',
    'tsconfig.web.json',
    'tsconfig.mobile.json',
    'vite.config.ts',
    'vite.mobile.config.ts',
    '.gitignore',
    '.dockerignore',
    '.gitattributes',
    'tests',
    '启动学习站.cmd',
    'release.cmd',
    'release.ps1',
    'release.sh',
  ]);
  // mobile/assets is generated and contains only public resources, but is rebuilt on demand.
  const cleanSource = source.filter((f) => !f.name.startsWith('mobile/assets/'));
  const runtime = onlySource
    ? []
    : await collectReleaseFiles(root, [
        ...common,
        'dist/package.json',
        'dist/server',
        'dist/shared',
        'dist/web',
      ]);
  runtime.push({
    name: '启动认知星图.cmd',
    data: Buffer.from(
      '@echo off\r\ncd /d "%~dp0"\r\nif not exist node_modules\\fastify call npm ci --omit=dev\r\nif errorlevel 1 exit /b 1\r\ncall npm start\r\n',
      'utf8',
    ),
  });
  const output = resolve(root, 'artifacts/releases');
  await mkdir(output, { recursive: true });
  const results = [];
  for (const [kind, files] of onlySource
    ? [['source', cleanSource]]
    : [
        ['source', cleanSource],
        ['runtime', runtime],
      ]) {
    const manifest = {
      product: '认知星图',
      project: 'noetic-atlas',
      version,
      kind,
      counts,
      dataBoundary: SOFTWARE_DATA_BOUNDARY,
      files: Object.fromEntries(
        files.map((f) => [f.name, createHash('sha256').update(f.data).digest('hex')]),
      ),
    };
    files.push({
      name: 'release-manifest.json',
      data: Buffer.from(JSON.stringify(manifest, null, 2)),
    });
    const name = `noetic-atlas-${version}-${kind}.zip`,
      data = createZip(files, `noetic-atlas-${version}`);
    await writeFile(join(output, name), data);
    results.push({
      file: name,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  return { version, counts, artifacts: results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  packageWebRelease({ onlySource: process.argv.includes('--only-source') })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
