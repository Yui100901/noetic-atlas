/** Self-contained Windows ZIP: Electron UI + official Node + production server. */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { packager } from '@electron/packager';
import { createZip, SOFTWARE_DATA_BOUNDARY } from './release-web.mjs';
import { validateEmptyInstall, validateBaseConfiguration } from './validate-public-data.mjs';

const root = resolve(import.meta.dirname, '../..');
export const NODE_VERSION = '24.22.0';
// Pinned against the official release SHASUMS256.txt; not a local runtime copy.
const NODE_ZIP_SHA256 = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3';
const NODE_EXE_SHA256 = 'ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c';
function inside(path) {
  const target = resolve(path);
  if (!target.startsWith(root + sep)) throw new Error('打包路径越出项目目录');
  return target;
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function run(binary, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? done() : reject(new Error(`打包子命令失败（${code}）`)),
    );
  });
}
function npmCli() {
  const path = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ].find((p) => p && existsSync(p));
  if (!path) throw new Error('请通过npm命令执行打包');
  return path;
}
async function officialNode() {
  const cache = inside(join(root, '.localtools/desktop-cache'));
  await mkdir(cache, { recursive: true });
  const name = `node-v${NODE_VERSION}-win-x64`,
    archive = join(cache, `${name}.zip`),
    extracted = join(cache, name);
  if (!existsSync(archive) || (await sha256(archive)) !== NODE_ZIP_SHA256) {
    const temporary = inside(archive + '.part');
    await rm(temporary, { force: true });
    console.log(`下载官方 Node.js ${NODE_VERSION} Windows 运行时…`);
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.zip`, {
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok || !response.body)
      throw new Error(`Node运行时下载失败：HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      if ((await sha256(temporary)) !== NODE_ZIP_SHA256)
        throw new Error('Node运行时SHA256校验失败');
      await copyFile(temporary, archive);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  if (
    !existsSync(join(extracted, 'node.exe')) ||
    (await sha256(join(extracted, 'node.exe'))) !== NODE_EXE_SHA256
  ) {
    await rm(inside(extracted), { recursive: true, force: true });
    await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'scripts/build/extract-runtime.ps1'),
      '-Archive',
      archive,
      '-Destination',
      cache,
    ]);
  }
  if ((await sha256(join(extracted, 'node.exe'))) !== NODE_EXE_SHA256)
    throw new Error('解压后的Node程序校验失败');
  return extracted;
}
async function electronArchive(version) {
  const directory = inside(join(root, '.localtools/desktop-cache/electron'));
  await mkdir(directory, { recursive: true });
  const name = `electron-v${version}-win32-x64.zip`,
    archive = join(directory, name);
  const checksums = JSON.parse(
      await readFile(join(root, 'node_modules/electron/checksums.json'), 'utf8'),
    ),
    expected = checksums[name];
  if (!/^[a-f0-9]{64}$/.test(expected || ''))
    throw new Error('锁定的Electron包没有对应Windows校验信息');
  if (existsSync(archive) && (await sha256(archive)) === expected) return directory;
  const urls = [
    `https://github.com/electron/electron/releases/download/v${version}/${name}`,
    `https://npmmirror.com/mirrors/electron/${version}/${name}`,
  ];
  for (let i = 0; i < urls.length; i++) {
    const temporary = inside(archive + '.part');
    await rm(temporary, { force: true });
    try {
      console.log(`下载 Electron ${version}：${i === 0 ? '官方发布站' : '校验镜像'}…`);
      const response = await fetch(urls[i], {
        signal: AbortSignal.timeout(i === 0 ? 20000 : 180000),
      });
      if (!response.ok || !response.body) throw new Error('下载不可用');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      if ((await sha256(temporary)) !== expected) throw new Error('Electron校验失败');
      await copyFile(temporary, archive);
      return directory;
    } catch {
      if (i === urls.length - 1)
        throw new Error('Electron下载未完成，请检查网络后重新打包；未经校验的运行时不会使用');
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
async function filesIn(directory) {
  const files = [];
  const canonical = await realpath(directory);
  async function visit(path) {
    const actual = await realpath(path);
    if (!actual.startsWith(canonical + sep)) throw new Error('便携包存在越界链接');
    const name = relative(directory, path).replaceAll('\\', '/'),
      info = await stat(path);
    if (info.isDirectory())
      for (const child of (await readdir(path)).sort()) await visit(join(path, child));
    else {
      if (
        /^data(?:\/|$)|(?:^|\/)(?:\.env[^/]*|local\.properties|\.localtools|test-results)(?:\/|$)|\.(?:sqlite(?:-[\w]+)?|keystore|jks|log)$/i.test(
          name,
        )
      )
        throw new Error(`便携包混入用户文件：${name}`);
      files.push({ name, data: await readFile(path) });
    }
  }
  for (const name of (await readdir(directory)).sort()) await visit(join(directory, name));
  return files;
}
export async function packageWindowsRelease({ reuseBuild = false, skipChecks = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows打包目前要求Windows构建机');
  process.chdir(root);
  const config = JSON.parse(await readFile('package.json', 'utf8'));
  if (!reuseBuild) {
    if (!skipChecks) await run(process.execPath, [npmCli(), 'test']);
    await run(process.execPath, [npmCli(), 'run', 'build']);
  }
  const counts = validateEmptyInstall();
  validateBaseConfiguration(JSON.parse(await readFile(join(root, 'config/defaults.json'), 'utf8')));
  const staging = inside(join(root, '.localtools/release-staging/windows'));
  await rm(staging, { recursive: true, force: true });
  const shell = join(staging, 'shell'),
    server = join(staging, 'server'),
    node = join(staging, 'node');
  await Promise.all([
    mkdir(join(shell, 'desktop'), { recursive: true }),
    mkdir(server, { recursive: true }),
    mkdir(node, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(shell, 'package.json'),
      JSON.stringify(
        {
          name: 'noetic-atlas',
          productName: '认知星图',
          description: '认知星图便携学习工作台',
          author: 'Noetic Atlas',
          version: config.version,
          main: 'desktop/main.cjs',
          type: 'commonjs',
        },
        null,
        2,
      ),
    ),
    ...['main.cjs', 'runtime.cjs'].map((name) =>
      copyFile(join(root, 'desktop', name), join(shell, 'desktop', name)),
    ),
    cp(join(root, 'desktop'), join(server, 'desktop'), { recursive: true }),
    cp(join(root, 'dist'), join(server, 'dist'), {
      recursive: true,
      filter: (path) => {
        const part = relative(join(root, 'dist'), path).split(sep)[0];
        return !part || ['package.json', 'server', 'shared', 'web'].includes(part);
      },
    }),
    copyFile('package.json', join(server, 'package.json')),
    copyFile('package-lock.json', join(server, 'package-lock.json')),
  ]);
  console.log('准备独立生产依赖和桌面运行时…');
  const [nodeSource, electronZipDir] = await Promise.all([
    officialNode(),
    electronArchive(config.devDependencies.electron),
    run(
      process.execPath,
      [
        npmCli(),
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--fetch-timeout=30000',
        '--fetch-retries=1',
      ],
      { cwd: server },
    ),
  ]);
  await Promise.all(
    ['node.exe', 'LICENSE'].map((name) => copyFile(join(nodeSource, name), join(node, name))),
  );
  const output = inside(join(root, 'artifacts/windows')),
    appDir = inside(join(output, 'noetic-atlas-win32-x64'));
  if (existsSync(join(appDir, 'data')))
    throw new Error('已有便携目录包含data，请先保留该目录中的用户数据，再重新打包');
  console.log('打包 Windows 桌面程序…');
  const [folder] = await packager({
    dir: shell,
    out: output,
    name: 'noetic-atlas',
    executableName: 'noetic-atlas',
    platform: 'win32',
    arch: 'x64',
    electronVersion: config.devDependencies.electron,
    electronZipDir,
    appVersion: config.version,
    buildVersion: config.version,
    asar: true,
    overwrite: true,
    prune: false,
    extraResource: [server, node],
    win32metadata: {
      ProductName: '认知星图',
      FileDescription: '认知星图便携学习工作台',
      OriginalFilename: 'noetic-atlas.exe',
    },
  });
  await mkdir(join(folder, 'config'), { recursive: true });
  await copyFile(join(root, 'config/defaults.json'), join(folder, 'config/defaults.json'));
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md'])
    if (existsSync(join(root, name))) await copyFile(join(root, name), join(folder, name));
  await writeFile(
    join(folder, '使用说明.txt'),
    '认知星图 / Noetic Atlas\r\n\r\n解压整个目录，双击 noetic-atlas.exe。无需安装 Node.js 或运行 npm。\r\n程序关闭后会停止专用本地服务。数据保存在同级 data 文件夹，升级时请保留。\r\n不要只复制EXE；resources及DLL等文件均需一起保留。\r\n发布包不包含个人配置或API凭据，AI需要自行配置。\r\n',
    'utf8',
  );
  const files = await filesIn(folder),
    manifest = {
      project: 'noetic-atlas',
      product: '认知星图',
      version: config.version,
      kind: 'windows-x64',
      electronVersion: config.devDependencies.electron,
      nodeVersion: NODE_VERSION,
      counts,
      dataBoundary: SOFTWARE_DATA_BOUNDARY,
      files: Object.fromEntries(
        files.map((f) => [f.name, createHash('sha256').update(f.data).digest('hex')]),
      ),
    };
  const manifestData = Buffer.from(JSON.stringify(manifest, null, 2));
  files.push({ name: 'release-manifest.json', data: manifestData });
  await writeFile(join(folder, 'release-manifest.json'), manifestData);
  const releases = inside(join(root, 'artifacts/releases'));
  await mkdir(releases, { recursive: true });
  const filename = `noetic-atlas-${config.version}-windows-x64.zip`,
    data = createZip(files, `noetic-atlas-${config.version}-windows-x64`);
  await writeFile(join(releases, filename), data);
  const result = {
    target: 'windows',
    file: `artifacts/releases/${filename}`,
    directory: relative(root, folder).replaceAll('\\', '/'),
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  packageWindowsRelease({
    reuseBuild: process.argv.includes('--reuse-build'),
    skipChecks: process.argv.includes('--skip-checks'),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
