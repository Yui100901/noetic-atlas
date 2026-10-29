/** Export reviewed public questions independently from software releases. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../../server/core/store.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/routes.js';
import type { Domain, Question } from '../../shared/models/types.js';
import type { SharePackage } from '../../shared/models/sharing.js';
import { asShare } from './manage.js';
// @ts-expect-error Release helpers deliberately use plain JavaScript.
import { createZip } from '../release/release-web.mjs';
// @ts-expect-error Release helpers deliberately use plain JavaScript.
import { normalizeReleaseVersion } from '../release/version.mjs';

const projectRoot = resolve(import.meta.dirname, '../..');
export const DOMAIN_PART_MAX_QUESTIONS = 500;
export const DOMAIN_PART_MAX_BYTES = 80 * 1024 * 1024;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
type File = { name: string; data: Buffer };
type DomainPart = File & { share: SharePackage };
export interface DomainExportOptions {
  root?: string;
  database?: string;
  output?: string;
  domains?: string[];
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
const safeName = (id: string) => {
  const normalized = id.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0,90);
  return normalized === id ? id : `${normalized || 'domain'}-${sha(id).slice(0,12)}`;
};

/** Both limits apply to the final UTF-8 JSON, including embedded pictures. */
export function buildDomainParts(
  store: Store, domain: Domain, ids: string[], exportedAt: string,
  maxBytes = DOMAIN_PART_MAX_BYTES,
): DomainPart[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DOMAIN_PART_MAX_BYTES)
    throw new Error('分包大小限制无效');
  const output: DomainPart[] = [];
  for (let start = 0; start < ids.length;) {
    let count = Math.min(DOMAIN_PART_MAX_QUESTIONS, ids.length - start);
    for (;;) {
      const selected = ids.slice(start, start + count);
      const publicData = exportShare(store, { kind: 'questions', ids: selected });
      if (publicData.questions.some(question => question.collection !== 'general' || question.status !== 'published'))
        throw new Error('领域导出只能包含已发布的通用题目');
      const pending = publicData.questions.map(question => ({ ...question, status: 'pending' as const }));
      const share = { ...asShare(publicData, `${domain.name} · ${start+1}–${start+count}`, pending), exportedAt } as SharePackage;
      const data = Buffer.from(JSON.stringify(share), 'utf8');
      if (data.length < maxBytes) {
        output.push({ name: `part-${String(output.length+1).padStart(3,'0')}.json`, data, share });
        start += count;
        break;
      }
      if (count === 1) throw new Error(`单题及其完整依赖已达到分包大小上限：${selected[0]}`);
      count = Math.max(1, Math.floor(count / 2));
    }
  }
  return output;
}

/** Validate each part against an empty recipient; never accumulate 30k rows. */
function validatePart(part: DomainPart): void {
  if (part.share.papers.length || part.share.questionBanks.length)
    throw new Error('领域题目导出不应包含个人卷或题库集合');
  const recipient = new Store(':memory:');
  try {
    const preview = planShareImport(recipient, part.share).preview;
    if (preview.counts.questions?.added !== part.share.questions.length)
      throw new Error('独立分包预览题数不一致：' + part.name);
    importShare(recipient, part.share, preview.fingerprint);
    const imported = recipient.all<Question>('questions');
    if (imported.length !== part.share.questions.length || imported.some(q => q.status !== 'pending' || q.collection !== 'general'))
      throw new Error('独立分包未正确进入待审核：' + part.name);
  } finally { recipient.database.close(); }
}

/** Only source metadata and licences; no broad data/ or docs/ traversal. */
async function collectNotices(root: string): Promise<File[]> {
  const output: File[] = [];
  for (const [directory, prefix] of [['data/content-sources','sources'],['docs/licenses','licenses']]) {
    const directoryPath = resolve(root, directory!);
    if (!await exists(directoryPath)) continue;
    const allowedRoot = await realpath(directoryPath);
    if (allowedRoot !== directoryPath) throw new Error('来源或许可目录不能是符号链接：' + directory);
    async function visit(path: string): Promise<void> {
      const actual = await realpath(path);
      if (actual !== allowedRoot && !actual.startsWith(allowedRoot + sep))
        throw new Error('来源或许可文件超出允许目录');
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('来源或许可目录包含符号链接');
      if (info.isDirectory()) {
        for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      } else if (info.isFile()) {
        if (!/\.(?:jsonl?|md|txt|html?)$|(?:^|[\\/])(?:LICENSE|NOTICE|COPYING)$/i.test(path)) return;
        if (info.size > 20 * 1024 * 1024) throw new Error('来源元数据文件过大：' + basename(path));
        output.push({ name: prefix + '/' + relative(allowedRoot, path).replaceAll('\\','/'), data: await readFile(path) });
      }
    }
    await visit(directoryPath);
  }
  return output;
}

async function removeTemporarySnapshot(directory: string, parent: string): Promise<void> {
  const absolute = resolve(directory), actual = await realpath(directory), actualParent = await realpath(parent);
  // Never recursively delete a computed path without proving this exact,
  // directly-owned mkdtemp child is still inside the intended temp directory.
  if (absolute !== actual || dirname(actual) !== actualParent || !/^noetic-atlas-domain-export-[A-Za-z0-9]+$/.test(basename(actual)))
    throw new Error('临时副本目录未通过安全清理检查');
  await rm(absolute, { recursive: true, force: true });
}

const rightsFor = (domain: Domain) => ({
  policy: 'existing-source-specific',
  blanketSublicense: false,
  redistributionReviewRequired: domain.id === 'driving',
  notice: domain.id === 'driving'
    ? '驾驶包含官方公开历史资料；公开可访问不等于已获再分发许可。分发前须逐项核对来源权利与现行有效性。'
    : '题目及参考来源分别适用原有权利与许可；本导出不对全部内容另授统一再许可。',
});

export async function exportDomainPacks(options: DomainExportOptions = {}) {
  const root = await realpath(resolve(options.root || projectRoot));
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (packageJson.name !== 'noetic-atlas') throw new Error('项目名或版本无效');
  const version: string = normalizeReleaseVersion(packageJson.version);
  const database = resolve(root, options.database || 'data/noetic-atlas.sqlite');
  const output = resolve(root, options.output || `artifacts/domain-packs/v${version}`);
  if (await exists(output)) throw new Error('输出目录已存在，请指定新目录，避免混入旧文件');
  if (!await exists(database)) throw new Error('工作数据库不存在，请使用 --database 指定现有数据库');
  if (!(await lstat(database)).isFile()) throw new Error('数据库路径必须是文件');
  if (options.domains?.some(id => !id.trim())) throw new Error('--domains 不能包含空领域');

  const temporaryParent = await realpath(tmpdir());
  const temporary = await mkdtemp(join(temporaryParent, 'noetic-atlas-domain-export-'));
  let source: DatabaseConnection | undefined;
  let store: Store | undefined;
  try {
    source = new DatabaseConnection(database, false);
    const snapshot = join(temporary, 'snapshot.sqlite');
    await source.backupTo(snapshot);
    source.close(); source = undefined;
    store = new Store(snapshot);
    const taxonomy = store.taxonomy();
    const categoryDomains = new Map(taxonomy.categories.map(category => [category.id, category.domainId]));
    const publicQuestions = store.questionMetadata({ collection: 'general', status: 'published' });
    const domainsByQuestion = new Map(publicQuestions.map(question => [question.id, new Set(question.categoryIds.map(id => categoryDomains.get(id)).filter((id): id is string => !!id))]));
    const requested = new Set(options.domains?.map(id => id.trim()) || []);
    if ([...requested].some(id => !taxonomy.domains.some(domain => domain.id === id))) throw new Error('--domains 包含不存在的领域');
    const domains = taxonomy.domains.filter(domain => (!requested.size || requested.has(domain.id)) && [...domainsByQuestion.values()].some(ids => ids.has(domain.id)));
    if (requested.size && domains.length !== requested.size) throw new Error('所选领域没有已发布的通用题目');
    if (!domains.length) throw new Error('没有可导出的已发布通用题目');
    const notices = await collectNotices(root);
    const exportedAt = new Date().toISOString();
    await mkdir(dirname(output), { recursive: true });
    // Exclusive claim: an existing output is never merged or overwritten.
    await mkdir(output);
    const artifacts = [];
    const included = new Map<string, number>();
    let memberships = 0;
    for (const domain of domains) {
      const ids = publicQuestions.filter(question => domainsByQuestion.get(question.id)!.has(domain.id)).map(question => question.id).sort();
      for (const id of ids) included.set(id, (included.get(id) || 0) + 1);
      memberships += ids.length;
      const parts = buildDomainParts(store, domain, ids, exportedAt);
      const assetIds = new Set<string>();
      for (const part of parts) { validatePart(part); for (const asset of part.share.assets) assetIds.add(asset.id); }
      const rights = rightsFor(domain);
      const partRecords = parts.map(part => ({ file: part.name, questions: part.share.questions.length, bytes: part.data.length, sha256: sha(part.data), questionIds: part.share.questions.map(question => question.id), validatedImport: true }));
      const files: File[] = [...parts.map(({name,data}) => ({name,data})), ...notices];
      const instructions = `# 认知星图 · ${domain.name}题库\n\n版本：${version}。本包含${ids.length}道通用题，分为${parts.length}份；不含应用程序、私人资料、学习记录、草稿、配置或AI凭据。\n\n1. 解压后在“分享与导入”逐份选择part-*.json，查看预览并确认。每份最多500题且小于80MiB，自带分类祖先、跨领域归属、标签与所需图片。\n2. 新题全部进入待审核，须由接收者核对后发布；重复题可复用原ID，跨化学/医药的同一药物不重复存储。\n3. 跨分包关联题保留可读文字或搜索入口；词头引用在接收方已有词表中解析。原始出处与许可仍保留。\n\n${rights.notice}\n\n驾驶历史原答案须结合现行规则核验，审核发布不代表历史规则恢复效力。sources/和licenses/是来源元数据与许可，可包括其他领域的来源目录，但不含其他领域题目。具体权利以对应来源为准，不能将某个来源的许可套用于整个题库。\n\ndomain-manifest.json与SHA256SUMS.txt用于核对文件完整性，不替代内容审核。\n`;
      files.push({ name: 'README.md', data: Buffer.from(instructions) });
      const manifest = {
        format: 'noetic-atlas-domain-content', schemaVersion: 1, project: 'noetic-atlas', version, exportedAt,
        domain: { id: domain.id, name: domain.name }, questions: ids.length, questionIds: ids,
        selection: { collection: 'general', sourceStatus: 'published', importedStatus: 'pending' },
        includesUserData: false, reviewRequired: true, redistributionReviewRequired: rights.redistributionReviewRequired,
        rights, assets: assetIds.size, parts: partRecords,
        files: Object.fromEntries(files.map(file => [file.name, { bytes: file.data.length, sha256: sha(file.data) }])),
      };
      files.push({ name: 'domain-manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
      files.push({ name: 'SHA256SUMS.txt', data: Buffer.from(files.map(file => `${sha(file.data)}  ${file.name}`).join('\n') + '\n') });
      const slug = safeName(domain.id);
      const filename = `noetic-atlas-content-${slug}-${version}.zip`;
      const zip = createZip(files, `noetic-atlas-content-${slug}-${version}`) as Buffer;
      await writeFile(join(output, filename), zip, { flag: 'wx' });
      artifacts.push({ domainId: domain.id, domainName: domain.name, file: filename, questions: ids.length, questionIds: ids, parts: parts.length, assets: assetIds.size, bytes: zip.length, sha256: sha(zip), redistributionReviewRequired: rights.redistributionReviewRequired, rights });
    }
    const manifest = {
      format: 'noetic-atlas-domain-packs', schemaVersion: 1, project: 'noetic-atlas', version, exportedAt,
      selection: { collection: 'general', sourceStatus: 'published', importedStatus: 'pending' },
      includesUserData: false, reviewRequired: true, standalonePartValidation: true,
      domains: artifacts,
      counts: { domains: artifacts.length, uniqueQuestions: included.size, domainQuestionMemberships: memberships, crossDomainQuestions: [...included.values()].filter(count => count > 1).length, duplicateMemberships: memberships - included.size },
      crossDomainNote: '计数范围为本次选择的领域。同题可以归属多个领域；领域题数之和可大于独立题数。跨域药物沿用同一题号，导入相同内容可复用，不复制药物身份。',
    };
    const manifestData = JSON.stringify(manifest, null, 2) + '\n';
    await writeFile(join(output, 'domain-manifest.json'), manifestData, { flag: 'wx' });
    await writeFile(join(output, 'CONTENT-SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + `\n${sha(manifestData)}  domain-manifest.json\n`, { flag: 'wx' });
    return { output, ...manifest };
  } finally {
    try { source?.close(); }
    finally {
      try { store?.database.close(); }
      finally { await removeTemporarySnapshot(temporary, temporaryParent); }
    }
  }
}

export async function main(args = process.argv.slice(2)) {
  const options: DomainExportOptions = {};
  while (args.length) {
    const option = args.shift();
    if (!['--database','--output','--domains'].includes(option || '')) throw new Error('未知参数：' + option);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(option + ' 需要参数值');
    if (option === '--database') options.database = value;
    else if (option === '--output') options.output = value;
    else options.domains = value.split(',');
  }
  const result = await exportDomainPacks(options);
  console.log(JSON.stringify({ output: result.output, version: result.version, counts: result.counts, artifacts: result.domains.map(({questionIds,...item}) => item) }, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
