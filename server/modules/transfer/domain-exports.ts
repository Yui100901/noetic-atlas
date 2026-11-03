import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { bytesToBase64 } from '../../../shared/assets/assets.js';
import { createStoredZip, type ZipEntry } from '../../../shared/exports/zip.js';
import type {
  ContentExportBuildInput,
  ContentExportFile,
  ContentExportPreview,
  ContentExportScope,
  ContentExportSelection,
} from '../../../shared/models/domain-exports.js';
import type { Category, Domain, Question, Tag } from '../../../shared/models/types.js';
import { now, type Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { readOnlyOperation } from '../../http/operation.js';
import {
  cleanContentQuestion,
  contentExportContext,
  detachQuestionLinks,
} from '../sharing/export-content.js';
import { validateShareExport } from '../sharing/schema.js';
import { contentExportBuildSchema, contentExportSelectionSchema } from './domain-export-schema.js';

const MiB = 1024 * 1024;
// Imports wrap this JSON in {data,mode}; reserve room beneath the 80MiB HTTP cap.
export const CONTENT_EXPORT_LIMITS = Object.freeze({
  maxQuestions: 50000,
  maxPackageBytes: 128 * MiB,
  maxCombinedBytes: 80 * MiB - 1024,
  maxPartQuestions: 500,
  maxPartBytes: 80 * MiB - 1024,
});
const encoder = new TextEncoder();
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stable = <T extends { id: string }>(records: T[]): T[] =>
  [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const safeName = (id: string) => {
  const value =
    id
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 90) || 'domain';
  return value === id ? value : `${value}-${sha(id).slice(0, 12)}`;
};
function normalizedScope(input: ContentExportSelection): ContentExportScope {
  const purpose = input.purpose || 'migration';
  return {
    domainIds: [...input.domainIds].sort(),
    purpose,
    mode: input.mode || 'combined',
    status: input.status || (purpose === 'migration' ? 'all' : 'published'),
    collection: input.collection || (purpose === 'migration' ? 'all' : 'general'),
  };
}
interface QuestionHeader {
  id: string;
  categoryIds: string;
  tagIds: string;
  bytes: number;
}

/** Catalog and preview transfer only classification headers from the database.
 * Bodies are fingerprinted in the adapter, and decoded only during a build. */
function snapshot(store: Store, input: ContentExportSelection) {
  const scope = normalizedScope(input),
    db = store.database,
    x = db.expressions;
  const taxonomy = {
    domains: stable(store.all<Domain>('domains')),
    categories: stable(store.all<Category>('categories')),
    tags: stable(store.all<Tag>('tags')),
  };
  const domainMap = new Map(taxonomy.domains.map((value) => [value.id, value]));
  for (const id of scope.domainIds)
    if (!domainMap.has(id)) fail(404, 'EXPORT_DOMAIN_NOT_FOUND', `领域不存在：${id}`);
  const categoryMap = new Map(taxonomy.categories.map((value) => [value.id, value]));
  let query = db.query
    .selectFrom('questions')
    .select([
      'id',
      x.field<string>('data', 'categoryIds').as('categoryIds'),
      x.field<string>('data', 'tagIds').as('tagIds'),
      db.logicalBytes('data').as('bytes'),
    ])
    .orderBy('id');
  if (scope.status !== 'all') query = query.where(x.field('data', 'status'), '=', scope.status);
  if (scope.collection !== 'all')
    query = query.where(x.field('data', 'collection'), '=', scope.collection);
  const headers = db.all(query) as QuestionHeader[];
  const domainCounts = new Map(taxonomy.domains.map((value) => [value.id, 0]));
  const membership = new Map(scope.domainIds.map((id) => [id, [] as string[]]));
  const questionIds: string[] = [],
    categoryIds = new Set<string>(),
    tagIds = new Set<string>();
  let estimatedQuestionBytes = 0;
  for (const header of headers) {
    const categories = JSON.parse(header.categoryIds || '[]') as string[];
    const domains = new Set(
      categories.flatMap((id) =>
        categoryMap.get(id)?.domainId ? [categoryMap.get(id)!.domainId] : [],
      ),
    );
    let selected = false;
    for (const domain of domains) {
      domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      if (membership.has(domain)) {
        membership.get(domain)!.push(header.id);
        selected = true;
      }
    }
    if (!selected) continue;
    questionIds.push(header.id);
    estimatedQuestionBytes += Number(header.bytes);
    for (const id of categories) categoryIds.add(id);
    for (const id of JSON.parse(header.tagIds || '[]') as string[]) tagIds.add(id);
  }
  // Ancestors are part of the dependency count, including cross-domain taxonomy.
  for (const id of categoryIds) {
    let current = categoryMap.get(id);
    const seen = new Set([id]);
    while (current?.parentId) {
      if (seen.has(current.parentId)) fail(422, 'CATEGORY_CYCLE', '分类不能形成环');
      seen.add(current.parentId);
      categoryIds.add(current.parentId);
      current = categoryMap.get(current.parentId);
    }
  }
  const fingerprints = questionIds.length
    ? db.all(
        db.query
          .selectFrom('questions')
          .select(['id', db.recordFingerprint('data').as('fingerprint')])
          .where(x.idInJson('id', questionIds))
          .orderBy('id'),
      )
    : [];
  // Assets are immutable through the public API. Including their database-side
  // hashes also catches external repair/replacement without loading base64 into
  // the preview; unrelated asset changes conservatively invalidate a preview.
  const assetFingerprints = questionIds.length
    ? db.all(
        db.query
          .selectFrom('assets')
          .select(['id', db.recordFingerprint('data').as('fingerprint')])
          .orderBy('id'),
      )
    : [];
  const fingerprint = sha(JSON.stringify({ scope, taxonomy, fingerprints, assetFingerprints }));
  const domains = taxonomy.domains.map((value) => ({
    id: value.id,
    name: value.name,
    questionCount: domainCounts.get(value.id) || 0,
  }));
  const selectedDomains = scope.domainIds.map((id) => domains.find((value) => value.id === id)!);
  const memberships = [...membership.values()].reduce((sum, ids) => sum + ids.length, 0);
  const emptyDomainIds = selectedDomains
    .filter((value) => !value.questionCount)
    .map((value) => value.id);
  const warnings = [
    scope.purpose === 'migration'
      ? '可信迁移保留原审核状态和通用/个人归属。只导入你信任的迁移包；普通分享请使用分享用途。'
      : '内容分享通过分享导入进入待审核；不会直接发布新题目。',
    '仅包含题目及分类、标签和题内附件；不含学习记录、笔记、历史作答、草稿、修订、配置或凭据。',
    '教材引用保留书名、定位和摘录，解除本机原文关联，不附整本教材或未选择的题目正文。',
    '大小为题目源数据估算，不包含附件、分类和封包开销；生成时检查真实UTF-8字节：单份JSON小于80MiB，ZIP最多128MiB，超限请拆分或分次选择领域。',
    ...(memberships > questionIds.length
      ? ['跨领域题目在合并文件内去重；按领域分文件时可重复附带，接收方合并导入会按题号复用。']
      : []),
    ...(scope.mode === 'per_domain'
      ? ['按领域文件超过500题或80MiB时自动分片，每份JSON独立包含自身依赖；ZIP需解压后逐份导入。']
      : []),
    ...(emptyDomainIds.length
      ? ['部分所选领域在当前范围没有题目；按领域拆分时会跳过空领域并在清单注明。']
      : []),
    ...(questionIds.length > CONTENT_EXPORT_LIMITS.maxQuestions
      ? ['所选题量超过单次50000题限制，请减少所选领域。']
      : []),
  ];
  const preview: ContentExportPreview = {
    fingerprint,
    scope,
    domains,
    selectedDomains,
    questionCount: questionIds.length,
    memberships,
    emptyDomainIds,
    estimatedQuestionBytes,
    categories: categoryIds.size,
    tags: tagIds.size,
    limits: CONTENT_EXPORT_LIMITS,
    warnings,
  };
  return { preview, questionIds, membership, taxonomy };
}
export function previewContentExport(
  store: Store,
  input: ContentExportSelection,
): ContentExportPreview {
  return snapshot(store, input).preview;
}

export function buildContentExport(
  store: Store,
  input: ContentExportBuildInput,
): ContentExportFile {
  const source = snapshot(store, input),
    { preview, questionIds, membership, taxonomy } = source;
  if (input.expectedFingerprint !== preview.fingerprint)
    fail(409, 'CONTENT_EXPORT_STALE', '题库内容、依赖或导出范围已变化，请重新预览后生成');
  if (!preview.scope.domainIds.length)
    fail(400, 'CONTENT_EXPORT_DOMAINS_REQUIRED', '请至少选择一个领域');
  if (!questionIds.length)
    fail(422, 'EMPTY_CONTENT_EXPORT', '所选领域在当前范围没有题目，请调整状态或归属范围');
  if (questionIds.length > CONTENT_EXPORT_LIMITS.maxQuestions)
    fail(413, 'CONTENT_EXPORT_TOO_MANY_QUESTIONS', '单次最多导出50000道题，请分次选择领域');
  const questions = new Map<string, Question>(),
    db = store.database;
  // Bound JSON membership avoids SQL interpolation and parameter-count limits.
  // Decode each chosen source exactly once, shared by every domain/part.
  for (let offset = 0; offset < questionIds.length; offset += 500) {
    const ids = questionIds.slice(offset, offset + 500);
    for (const row of db.all(
      db.query.selectFrom('questions').select('data').where(db.expressions.idInJson('id', ids)),
    )) {
      const question = cleanContentQuestion(JSON.parse(row.data) as Question);
      if (preview.scope.purpose === 'share') question.status = 'pending';
      questions.set(question.id, question);
    }
  }
  if (questions.size !== questionIds.length)
    fail(409, 'CONTENT_EXPORT_STALE', '题目已变化，请重新预览后生成');
  const exportedAt = now(),
    date = exportedAt.slice(0, 10),
    context = contentExportContext(store, taxonomy);
  const payload = (ids: string[], title: string, selectedDomains: string[]) => {
    // Shared cross-domain duplicates must have identical authoring content in
    // every independently importable part. Keeping only in-part links would
    // vary their semantic graph and cause the recipient to remap duplicates.
    const chosen = new Set(ids);
    const linkMode =
      preview.scope.purpose === 'share' && preview.scope.mode === 'per_domain'
        ? 'search'
        : 'missing';
    const records = ids.map((id) => detachQuestionLinks(questions.get(id)!, chosen, linkMode));
    const dependencies = context.dependencies(records, null, selectedDomains);
    const base = {
      schemaVersion: 1 as const,
      exportedAt,
      ...dependencies,
      questions: records,
      papers: [],
      questionBanks: [],
    };
    return preview.scope.purpose === 'share'
      ? validateShareExport({ format: 'learning-share' as const, title, ...base })
      : { ...base, documents: [] };
  };
  const serialize = (value: unknown) => encoder.encode(JSON.stringify(value));
  const tooLarge = () =>
    fail(
      413,
      'CONTENT_EXPORT_TOO_LARGE',
      '导出包超过128MiB上限，请分次选择更少领域；单题过大时请先缩小题内附件',
    );
  const summary = {
    questionCount: questionIds.length,
    domainCount: preview.selectedDomains.length,
    fileCount: 1,
    purpose: preview.scope.purpose,
    mode: preview.scope.mode,
  };
  if (preview.scope.mode === 'combined') {
    const bytes = serialize(
      payload(questionIds, `领域题库（${questionIds.length}题）`, preview.scope.domainIds),
    );
    if (bytes.byteLength > CONTENT_EXPORT_LIMITS.maxCombinedBytes)
      fail(
        413,
        'CONTENT_EXPORT_COMBINED_TOO_LARGE',
        '合并JSON超过80MiB导入上限，请选择按领域分文件，或分次选择更少领域',
      );
    return {
      filename: `noetic-atlas-${preview.scope.purpose}-${date}.json`,
      mimeType: 'application/json',
      dataBase64: bytesToBase64(bytes),
      byteLength: bytes.byteLength,
      summary,
    };
  }
  const files: ZipEntry[] = [];
  const manifest: Array<{
    filename: string;
    domainId: string;
    domainName: string;
    part: number;
    questionCount: number;
    byteLength: number;
    sha256: string;
  }> = [];
  let totalFileBytes = 0;
  for (const [domainIndex, domain] of preview.selectedDomains.entries()) {
    const ids = membership.get(domain.id)!;
    let offset = 0,
      part = 1;
    while (offset < ids.length) {
      let size = Math.min(CONTENT_EXPORT_LIMITS.maxPartQuestions, ids.length - offset);
      let bytes: Uint8Array;
      while (true) {
        bytes = serialize(
          payload(
            ids.slice(offset, offset + size),
            `${domain.name} · ${offset + 1}–${offset + size}`,
            [domain.id],
          ),
        );
        if (bytes.byteLength <= CONTENT_EXPORT_LIMITS.maxPartBytes) break;
        if (size === 1)
          fail(
            413,
            'CONTENT_EXPORT_SINGLE_QUESTION_TOO_LARGE',
            `领域“${domain.name}”的一道题及附件超过80MiB分片上限，请缩小附件后重试`,
          );
        size = Math.max(1, Math.floor(size / 2));
      }
      // A distinct ordinal avoids collisions even between a normalized ID and
      // a deliberately chosen literal ID that mimics its hash suffix.
      const filename = `${String(domainIndex + 1).padStart(5, '0')}-${safeName(domain.id)}/part-${String(part).padStart(3, '0')}.json`;
      totalFileBytes += bytes.byteLength;
      if (totalFileBytes > CONTENT_EXPORT_LIMITS.maxPackageBytes) tooLarge();
      files.push({ name: filename, bytes });
      manifest.push({
        filename,
        domainId: domain.id,
        domainName: domain.name,
        part,
        questionCount: size,
        byteLength: bytes.byteLength,
        sha256: sha(bytes),
      });
      offset += size;
      part++;
    }
  }
  summary.fileCount = manifest.length;
  files.push({
    name: 'manifest.json',
    bytes: serialize({
      format: 'noetic-atlas-domain-export',
      schemaVersion: 1,
      exportedAt,
      scope: preview.scope,
      fingerprint: preview.fingerprint,
      questionCount: preview.questionCount,
      memberships: preview.memberships,
      emptyDomainIds: preview.emptyDomainIds,
      files: manifest,
    }),
  });
  files.push({
    name: 'README.md',
    bytes: encoder.encode(
      `# 认知星图领域题库\n\n用途：${preview.scope.purpose === 'migration' ? '可信迁移（保留审核和归属）' : '普通内容分享（新增题目待审核）'}。\n\n请先解压，按 manifest.json 的顺序逐个导入 JSON。${preview.scope.purpose === 'migration' ? '从系统配置 → 数据迁移的 JSON 合并导入，不要导入来源不明的迁移包。' : '从内容分享 → 导入分享包导入，并审核新增题目。'}\n\n每份 JSON 含自身分类祖先、标签和题内附件；超过500题或80MiB的领域自动分片。跨领域题目可能出现在多个文件，迁移合并会复用相同题号；分享导入按内容与关联关系安全复用。${preview.scope.purpose === 'share' ? '为保证跨领域及跨分片的同题内容一致，分享分包的全部关联题详情链接统一转为题号搜索；不直接跳转分包内题目。' : '未随文件附带的关联题链接已转为说明或题号搜索。'}\n\n教材引用保留书名、页码和摘录，不附教材原文。来源引用与许可信息保留在题目中，请遵守原始资料授权。\n\n不含学习记录、私有笔记、作答、配置、草稿、修订或AI凭据。\n`,
    ),
  });
  let bytes: Uint8Array;
  try {
    bytes = createStoredZip(files, CONTENT_EXPORT_LIMITS.maxPackageBytes);
  } catch {
    return tooLarge();
  }
  return {
    filename: `noetic-atlas-domains-${preview.scope.purpose}-${date}.zip`,
    mimeType: 'application/zip',
    dataBase64: bytesToBase64(bytes),
    byteLength: bytes.byteLength,
    summary,
  };
}

export function registerContentExportRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/content-exports/preview', readOnlyOperation, async (request) =>
    previewContentExport(store, parse(contentExportSelectionSchema, request.body)),
  );
  app.post('/api/content-exports', readOnlyOperation, async (request) =>
    buildContentExport(store, parse(contentExportBuildSchema, request.body)),
  );
}
