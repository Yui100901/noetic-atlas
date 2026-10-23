/** Prepare an isolated upload directory from the last successful build report.
 * This command never creates a repository, pushes Git or publishes a release.
 */
import { readFile, mkdir, writeFile, copyFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, basename, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { validateEmptyInstall, validateBaseConfiguration } from './validate-public-data.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function verifyEmptySoftwareZip(bytes) {
  let manifest, configuration;
  const entries = new Set();
  for (let offset = 0; offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50;) {
    const flags = bytes.readUInt16LE(offset + 6), method = bytes.readUInt16LE(offset + 8);
    if (flags & 8 || ![0, 8].includes(method)) throw new Error('软件ZIP编码不受支持，请用项目发布脚本重建');
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const relative = name.split('/').slice(1).join('/');
    if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').includes('..') || entries.has(relative)) throw new Error('软件ZIP路径无效');
    if (/^(?:data|resources\/server\/data)\//.test(relative) || /(?:^|\/)native-seed\.json$|\.(?:sqlite(?:-[\w]+)?|sqlite3(?:-[\w]+)?|db)$/i.test(relative)) throw new Error('软件ZIP含题库或工作数据：' + relative);
    if (/(?:^|\/)(?:\.localtools|signing\.json|key\.properties)(?:\/|$)|\.(?:keystore|jks|p12|pfx)$/i.test(relative)) throw new Error('软件ZIP含私有签名文件：' + relative);
    entries.add(relative);
    const start = offset + 30 + nameSize + extraSize;
    if (relative === 'release-manifest.json' || relative === 'config/defaults.json') {
      const compressed = bytes.subarray(start, start + size);
      const parsed = JSON.parse((method === 8 ? inflateRawSync(compressed) : compressed).toString('utf8'));
      if (relative === 'release-manifest.json') manifest = parsed;
      else configuration = parsed;
    }
    offset = start + size;
  }
  if (!manifest || manifest.dataBoundary?.installation !== 'empty-install' || manifest.dataBoundary?.includesQuestionData !== false
    || ['questions', 'domains', 'categories', 'tags'].some(key => manifest.counts?.[key] !== 0)
    || !entries.has('config/defaults.json')) throw new Error('软件ZIP不是空题库基础配置版本，请重新打包');
  validateBaseConfiguration(configuration);
}
export async function prepareGithubRelease({ root = resolve(import.meta.dirname, '../..'), output } = {}) {
  root = await realpath(root);
  const config = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (config.name !== 'noetic-atlas' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(config.version)) throw new Error('项目名或版本无效');
  const version = config.version, artifactsRoot = join(root, 'artifacts'), releaseRoot = join(artifactsRoot, 'releases');
  const initialData = validateEmptyInstall();
  const report = JSON.parse(await readFile(join(releaseRoot, 'release-report.json'), 'utf8'));
  if (report.project !== config.name || report.version !== version) throw new Error('发布报告版本不匹配，请重新打包');
  if (report.checksSkipped || report.targets?.some(target => target.status === 'failed')) throw new Error('发布报告含失败或跳过检查，请完成检查并重新打包');
  const destination = resolve(output || join(artifactsRoot, 'github', `v${version}`));
  if (!destination.startsWith(artifactsRoot + sep)) throw new Error('待上传目录必须位于项目 artifacts 内');
  // Refuse stale files rather than silently carrying old assets into a release.
  if (existsSync(destination)) throw new Error('待上传目录已存在；请使用 --output 指定新的空目录');
  const canonicalArtifacts = await realpath(artifactsRoot);
  if (!canonicalArtifacts.startsWith(root + sep)) throw new Error('artifacts 目录链接越出项目');
  let ancestor = dirname(destination);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonicalAncestor = await realpath(ancestor);
  if (canonicalAncestor !== canonicalArtifacts && !canonicalAncestor.startsWith(canonicalArtifacts + sep)) throw new Error('待上传目录链接越出 artifacts');
  const accepted = new Map([
    ...['source', 'runtime', 'windows-x64'].map(kind => [`noetic-atlas-${version}-${kind}.zip`, `noetic-atlas-${version}-${kind}.zip`]),
    ['noetic-atlas-release.apk', `noetic-atlas-${version}-android.apk`],
  ]);
  const files = [], excluded = [], names = new Set();
  let androidSigning;
  for (const artifact of report.artifacts || []) {
    const name = basename(artifact.file), targetName = accepted.get(name);
    if (!targetName) {
      if (/-(?:debug|release-unsigned)\.apk$/.test(name)) { excluded.push(name); continue; }
      throw new Error('发布报告出现非软件交付物：' + name);
    }
    if (names.has(targetName)) throw new Error('发布报告有重复交付物');
    const path = await realpath(resolve(releaseRoot, artifact.file));
    if (!path.startsWith(canonicalArtifacts + sep)) throw new Error('交付物路径越出 artifacts');
    if (!report.targets.some(target => target.status === 'built' && target.artifacts?.includes(artifact.file))) throw new Error('交付物没有本次成功构建记录：' + name);
    const bytes = await readFile(path);
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error('交付物摘要不匹配，请重新打包：' + name);
    if (name === 'noetic-atlas-release.apk') {
      let proof;
      try { proof = JSON.parse(await readFile(join(artifactsRoot, 'android-signing-report.json'), 'utf8')); }
      catch { throw new Error('正式 APK 缺少签名验证报告，请先执行 npm run android:signing:verify'); }
      if (!report.targets.some(target => target.target === 'android' && target.signed === true && target.installable === true && target.artifacts?.includes(artifact.file))
        || !proof || proof.signed !== true || proof.signatureVerified !== true || proof.alignmentVerified !== true || proof.schemes?.v2 !== true
        || proof.apk !== name || proof.sha256 !== artifact.sha256 || proof.bytes !== bytes.length
        || !/^[a-f0-9]{64}$/.test(proof.certificateSha256 || '') || proof.certificate?.sha256 !== proof.certificateSha256) throw new Error('正式 APK 的签名验证记录不匹配，请重新构建并验证');
      androidSigning = { file: targetName, sha256: artifact.sha256, certificateSha256: proof.certificateSha256, schemes: Object.fromEntries(['v1', 'v2', 'v3', 'v31', 'v4'].map(key => [key, proof.schemes[key] === true])) };
    }
    if (name.endsWith('.zip')) verifyEmptySoftwareZip(bytes);
    names.add(targetName); files.push({ path, file: targetName, bytes: bytes.length, sha256: artifact.sha256 });
  }
  if (!files.length) throw new Error('没有可上传的软件交付物');
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    await copyFile(file.path, join(destination, file.file));
    if (sha256(await readFile(join(destination, file.file))) !== file.sha256) throw new Error('复制期间交付物发生变化，禁止上传此目录');
  }
  const release = {
    product: '认知星图', project: config.name, version, tag: `v${version}`, preparedAt: new Date().toISOString(),
    softwareOnly: true, installation: 'empty-install', bundledData: 'none',
    baseConfiguration: 'config/defaults.json',
    expandedContentIncluded: false, userConfigurationIncluded: false, initialData,
    files: files.map(({ path: _path, ...entry }) => entry), excluded,
    ...(androidSigning ? { androidSigning } : {}),
  };
  const notes = `# 认知星图 ${version}\n\n本地优先的通用学习平台，支持知识题库、组卷练习、考试、学习记录和 AI 辅助。\n\n## 下载\n\n${files.map(file => `- \`${file.file}\``).join('\n')}\n\n软件首次启动为空题库，不内置领域、分类、标签或任何题目。包内仅附干净基础配置 config/defaults.json；AI 默认关闭，没有预设端点或凭据。题库按领域作为独立附件选择下载，解压后从“分享与导入”导入 part-*.json，再确认审核。软件附件不含工作数据库、学习记录或个人配置。\n\n## 配置与升级\n\n系统配置 → 数据与备份 → 配置迁移，可单独导出/导入常规配置及 AI 非敏感参数；密钥不会进入配置 JSON，换设备后重新填写。完整学习数据使用 JSON/SQLite 备份迁移。升级前备份，Windows 保留原 data/，Web 保留数据库，Android 使用相同签名覆盖安装。\n\n${excluded.length ? `本次未附 Android 调试包或未签名包：${excluded.map(name => `\`${name}\``).join('、')}。Android 正式安装包需完成签名。\n\n` : ''}使用和部署见仓库 README 与 docs/发布与部署.md；各附件 SHA256 见 SHA256SUMS.txt。\n`;
  await writeFile(join(destination, 'release-files.json'), JSON.stringify(release, null, 2) + '\n');
  await writeFile(join(destination, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.file}`).join('\n') + '\n');
  await writeFile(join(destination, 'RELEASE-NOTES.md'), notes);
  return { ...release, output: destination };
}

export async function main(args = process.argv.slice(2)) {
  let output;
  while (args.length) {
    const arg = args.shift();
    if (arg !== '--output' || !args.length || output) throw new Error('用法：npm run release:prepare -- [--output artifacts/github/目录]');
    output = resolve(args.shift());
  }
  const report = await prepareGithubRelease({ output });
  console.log(JSON.stringify({ version: report.version, output: report.output, files: report.files, excluded: report.excluded }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
