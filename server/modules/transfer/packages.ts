/** Manifest-directed transfer orchestration and routes. */
import { createHash } from 'node:crypto';
import { previewPackageExport, assertExportAllowed } from './export-preflight.js';
import type { AssetRecord } from '../../../shared/assets/assets.js';
import type { FastifyInstance } from 'fastify';
import { base64ToBytes, bytesToBase64 } from '../../../shared/assets/assets.js';
import {
  buildDataPackage,
  readDataPackage,
  DataPackageError,
} from '../../../shared/packages/data-package.js';
import type {
  DataPackageFile,
  DataPackageImportResult,
  DataPackagePreview,
} from '../../../shared/models/data-packages.js';
import { now, type Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { z } from 'zod';
import type { QuestionInput } from '../../../shared/models/types.js';
import { readOnlyOperation } from '../../http/operation.js';
import { questionImportTemplate } from '../questions/import-template.js';
import {
  exportPendingQuestions,
  importNewQuestionData,
  importPendingQuestions,
} from '../questions/import-export.js';
import { exportConfiguration, importConfiguration } from '../settings/configuration.js';
import { exportShare, importShare } from '../sharing/service.js';
import { exportData, importData } from './migration.js';
import { combinePackagePayloads } from './package-payload.js';
import { inspectDataPackage } from './package-preview.js';
import {
  PACKAGE_HTTP_BODY_LIMIT,
  packageExportSchema,
  packagePreviewInputSchema,
  packageImportInputSchema,
} from './package-schema.js';
export {
  PACKAGE_HTTP_BODY_LIMIT,
  packageExportSchema,
  packagePreviewInputSchema,
  packageImportInputSchema,
  packageFileSchema,
  packagePreviewSchema,
  packageImportResultSchema,
} from './package-schema.js';

const MiB = 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const previewQuestions = new WeakMap<
  Store,
  Array<{
    fingerprint: string;
    questions: QuestionInput[];
    images: Map<string, AssetRecord>;
    at: number;
    bytes: number;
  }>
>();
const cacheLimit = 256 * MiB,
  cacheAge = 10 * 60 * 1000;
function rememberQuestions(
  store: Store,
  fingerprint: string,
  questions: QuestionInput[],
  assets: AssetRecord[] = [],
) {
  const images = new Map(
    assets
      .filter((asset) => /^image\/(?:png|jpeg|gif|webp)$/.test(asset.mimeType))
      .map((asset) => [asset.id, asset]),
  );
  const bytes =
    questions.reduce((sum, question) => sum + JSON.stringify(question).length * 2, 0) +
    [...images.values()].reduce((sum, asset) => sum + asset.dataBase64.length * 2, 0);
  if (bytes > cacheLimit) fail(413, 'IMPORT_PREVIEW_TOO_LARGE', '题目预览体积过大，请分片导入');
  const now = Date.now(),
    values = (previewQuestions.get(store) || []).filter(
      (value) => value.fingerprint !== fingerprint && now - value.at < cacheAge,
    );
  values.push({ fingerprint, questions, images, at: now, bytes });
  while (values.length > 2 || values.reduce((sum, value) => sum + value.bytes, 0) > cacheLimit)
    values.shift();
  previewQuestions.set(store, values);
}
export function packageImportQuestion(store: Store, raw: unknown) {
  const input = parse(
    z
      .object({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        index: z.coerce.number().int().min(0).max(50000),
      })
      .strict(),
    raw,
  );
  const cached = (previewQuestions.get(store) || []).find(
    (value) => value.fingerprint === input.fingerprint && Date.now() - value.at < cacheAge,
  );
  if (!cached) fail(409, 'IMPORT_PREVIEW_EXPIRED', '题目预览已过期，请重新预览数据包');
  const question =
    cached!.questions[input.index] ||
    fail(404, 'IMPORT_QUESTION_NOT_FOUND', '导入预览中没有这道题');
  // Only validated images from this package become inline preview resources.
  // The authoritative payload and its fingerprints remain unchanged.
  const display = (value: unknown): unknown =>
    typeof value === 'string'
      ? value.replace(
          /\/api\/assets\/([^/\s?#"'()<>\]]+)\/(?:content|data)/g,
          (original, encoded: string) => {
            let id: string;
            try {
              id = decodeURIComponent(encoded);
            } catch {
              return original;
            }
            const asset = cached!.images.get(id);
            return asset ? `data:${asset.mimeType};base64,${asset.dataBase64}` : original;
          },
        )
      : Array.isArray(value)
        ? value.map(display)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, display(child)]))
          : value;
  return display(question) as QuestionInput;
}

async function opened(raw: unknown) {
  const input = parse(packagePreviewInputSchema, raw);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(input.dataBase64);
  } catch {
    return fail(400, 'INVALID_DATA_PACKAGE', '数据包编码无法解析');
  }
  try {
    const pkg = await readDataPackage(bytes);
    if (
      pkg.manifest.kind === 'configuration' &&
      (bytes.length > 2 * MiB ||
        pkg.manifest.files.reduce((total, file) => total + file.byteLength, 0) > 2 * MiB)
    )
      fail(413, 'PACKAGE_CONFIGURATION_LIMIT', '配置包最多2MiB');
    const data = combinePackagePayloads(pkg.manifest.kind, pkg.payloads, pkg.manifest.title);
    return { kind: pkg.manifest.kind, title: pkg.manifest.title, data, packageHash: hash(bytes) };
  } catch (error) {
    if (error instanceof DataPackageError) return fail(400, error.code, error.message);
    throw error;
  }
}

export async function previewDataPackage(store: Store, raw: unknown): Promise<DataPackagePreview> {
  const value = await opened(raw);
  const preview = inspectDataPackage(store, value.kind, value.title, value.data, value.packageHash);
  if (preview.dedup)
    rememberQuestions(store, preview.fingerprint, value.data.questions, value.data.assets || []);
  return preview;
}

export async function importDataPackage(
  store: Store,
  raw: unknown,
): Promise<DataPackageImportResult> {
  const input = parse(packageImportInputSchema, raw);
  const value = await opened({ dataBase64: input.dataBase64 });
  if (value.kind === 'migration' && !input.confirmedTrusted)
    fail(400, 'PACKAGE_TRUST_CONFIRMATION_REQUIRED', '请确认此迁移包来自可信来源');
  return store.transaction(() => {
    const preview = inspectDataPackage(
      store,
      value.kind,
      value.title,
      value.data,
      value.packageHash,
    );
    if (preview.fingerprint !== input.expectedFingerprint)
      fail(409, 'PACKAGE_PREVIEW_STALE', '数据包或本机相关内容在预览后已变化，请重新预览后导入');
    let result: unknown;
    if (value.kind === 'share')
      result = importShare(store, value.data, undefined, {
        expectedFingerprint: preview.dedup!.fingerprint,
        decisions: input.decisions,
      });
    else if (value.kind === 'migration') result = importData(store, value.data);
    else if (value.kind === 'configuration')
      result = importConfiguration(store, {
        data: value.data,
        fingerprint: preview.details!.fingerprint,
        confirmed: true,
        ...(input.confirmedRetention ? { confirmedRetention: true } : {}),
      });
    else if (value.kind === 'question-template')
      result = importNewQuestionData(store, value.data, {
        expectedFingerprint: preview.dedup!.fingerprint,
        decisions: input.decisions,
      });
    else if (value.kind === 'question-update') result = importPendingQuestions(store, value.data);
    else return fail(422, 'SQLITE_PACKAGE_RESTORE_REQUIRED', '请使用完整数据库恢复入口');
    return { ok: true, ...preview, result };
  });
}

// Full backups can contain large collections. Split on serialized bytes so
// import uses one transaction without requiring a monolithic JSON file.
function migrationParts(data: ReturnType<typeof exportData>) {
  const empty = {
    schemaVersion: 1,
    exportedAt: data.exportedAt,
    domains: [],
    categories: [],
    tags: [],
    questions: [],
    documents: [],
    papers: [],
    // An empty current history index is intentional. Omitting it would make
    // reimport treat this export as a legacy backup and recreate old answers.
    questionHistory: [],
  };
  const partitions: Array<{ path: string; data: unknown }> = [];
  let fragment: Record<string, unknown[]> = {};
  let size = 0;
  const encoder = new TextEncoder();
  const flush = () => {
    partitions.push({
      path: `data/part-${String(partitions.length + 1).padStart(3, '0')}.json`,
      data: { ...empty, ...fragment },
    });
    fragment = {};
    size = 0;
  };
  for (const [key, records] of Object.entries(data)) {
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      const estimate = encoder.encode(JSON.stringify(record)).length;
      if (size && size + estimate > 8 * MiB) flush();
      (fragment[key] ||= []).push(record);
      size += estimate;
    }
  }
  if (size || !partitions.length) flush();
  return partitions;
}

export async function exportDataPackage(store: Store, raw: unknown): Promise<DataPackageFile> {
  const input = parse(packageExportSchema, raw);
  assertExportAllowed(previewPackageExport(store, input));
  let data: unknown, title: string;
  if (input.kind === 'share') {
    if (!input.selection) fail(400, 'PACKAGE_SELECTION_REQUIRED', '请选择需要分享的题目或题集');
    const share = exportShare(store, input.selection!);
    data = share;
    title = share.title;
  } else if (input.kind === 'migration') {
    data = exportData(store);
    title = '认知星图完整备份';
  } else if (input.kind === 'configuration') {
    data = exportConfiguration(store, input.includeAi ?? true);
    title = '认知星图配置';
  } else if (input.kind === 'question-template') {
    data = questionImportTemplate();
    title = '认知星图新增题目模板';
  } else {
    data = exportPendingQuestions(
      store,
      input.ids || fail(400, 'PACKAGE_SELECTION_REQUIRED', '请选择待审核题目'),
    );
    title = '认知星图待审核题目';
  }
  try {
    const files =
      input.kind === 'question-template'
        ? [
            {
              path: 'taxonomy/reference.json',
              mediaType: 'application/json',
              bytes: new TextEncoder().encode(
                JSON.stringify(
                  {
                    usage:
                      '此文件仅供填写题目categoryIds/tagIds参考，不作为导入内容；新增领域与标签请先在分类与标签中建立。',
                    ...store.taxonomy(),
                  },
                  null,
                  2,
                ),
              ),
            },
          ]
        : undefined;
    const payloads =
      input.kind === 'migration'
        ? migrationParts(data as ReturnType<typeof exportData>)
        : [{ path: 'data/content.json', data }];
    const bytes = await buildDataPackage({
      kind: input.kind,
      title,
      payloads,
      ...(files ? { files } : {}),
    });
    const filename = `${title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}-${now().slice(0, 10)}.zip`;
    return {
      filename,
      mimeType: 'application/zip',
      dataBase64: bytesToBase64(bytes),
      byteLength: bytes.length,
    };
  } catch (error) {
    if (error instanceof DataPackageError)
      return fail(
        422,
        'DATA_PACKAGE_EXPORT_LIMIT',
        input.kind === 'migration'
          ? error.message + '。可使用 SQLite 完整数据库包备份。'
          : error.message + '。请缩小筛选范围或到系统配置按领域分次导出。',
      );
    throw error;
  }
}

export function registerDataPackageRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/packages/import-question', (request) =>
    packageImportQuestion(store, request.query),
  );
  app.post('/api/packages/export-preview', readOnlyOperation, (request) =>
    previewPackageExport(store, request.body),
  );
  app.post('/api/packages/export', readOnlyOperation, (request) =>
    exportDataPackage(store, request.body),
  );
  app.post(
    '/api/packages/preview',
    { ...readOnlyOperation, bodyLimit: PACKAGE_HTTP_BODY_LIMIT },
    (request) => previewDataPackage(store, request.body),
  );
  app.post('/api/packages/import', { bodyLimit: PACKAGE_HTTP_BODY_LIMIT }, (request) =>
    importDataPackage(store, request.body),
  );
}
