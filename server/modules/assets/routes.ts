import type { FastifyInstance, FastifyRequest } from 'fastify';
import { assetIdFromUrl, embeddedRasterImage, type AssetRecord, type AssetMetadata } from '../../../shared/assets/assets.js';
import { collectAssetReferences } from '../../../shared/assets/asset-references.js';
export { collectAssetReferences } from '../../../shared/assets/asset-references.js';
import { assetInputSchema, decodeAssetBase64, sanitizeAssetFilename, validateAssetBytes, type AssetLimits } from './schema.js';
import { Store, makeId, now } from '../../core/store.js';
import { fail, id, parse } from '../../core/validation.js';
import { getSettings } from '../settings/routes.js';
import { z } from 'zod';
import { paginationFields } from '../../core/pagination.js';

const getId = (request: FastifyRequest) => parse(id, (request.params as { id: string }).id);
export const assetMetadata = ({ dataBase64: _data, ...metadata }: AssetRecord): AssetMetadata => metadata;
function validateEmbeddedAndImageReferences(store: Store, value: unknown, limits: AssetLimits) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
      const url = match[1]!; const assetId = assetIdFromUrl(url);
      if (assetId && !store.require<AssetRecord>('assets', assetId).mimeType.startsWith('image/')) fail(400, 'ASSET_NOT_IMAGE', '题目或资料的 Markdown 图片必须引用图片文件');
      if (url.startsWith('data:')) { const image = embeddedRasterImage(url); if (!image) fail(400, 'INVALID_INLINE_IMAGE', '内嵌图片仅支持 PNG、JPEG、GIF 或 WebP 的规范 Base64 编码'); validateAssetBytes(decodeAssetBase64(image!.dataBase64), image!.mimeType, limits); }
    }
  } else if (Array.isArray(value)) for (const entry of value) validateEmbeddedAndImageReferences(store, entry, limits);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) if (key !== 'dataBase64') validateEmbeddedAndImageReferences(store, entry, limits);
}
export function validateAssetReferences(store: Store, record: unknown, limits?: AssetLimits) {
  for (const aid of collectAssetReferences(record)) if (!store.get('assets', aid)) fail(400, 'INVALID_ASSET_REFERENCE', `引用的本地文件不存在：${aid}`);
  // Migration uses the hard limit so lowering current upload limits never damages existing records.
  validateEmbeddedAndImageReferences(store, record, limits || { maxDocumentMiB: 100, maxImageMiB: 100 });
  const doc = record as { format?: string; assetId?: string | null } | null;
  if (doc?.format === 'pdf' && (!doc.assetId || store.get<AssetRecord>('assets', doc.assetId)?.mimeType !== 'application/pdf')) fail(400, 'PDF_ASSET_REQUIRED', 'PDF 资料必须关联已上传的 PDF 文件');
  if (doc && 'bodyMarkdown' in doc && doc.format !== 'pdf' && doc.assetId) fail(400, 'MARKDOWN_ASSET_NOT_ALLOWED', 'Markdown 资料直接保存可编辑正文，不关联原始文件资产');
}
export function validateAllAssetReferences(store: Store) {
  for (const table of ['questions', 'documents', 'papers', 'attempts', 'study', 'reviews'] as const) for (const record of store.all(table)) validateAssetReferences(store, record);
}
/** Derived references use the same structural collector as writes/migration;
 * a file page never scans source bodies or historical snapshots. */
function referencedAssetIds(store: Store, wanted: Set<string>): Set<string> {
  if (!wanted.size) return new Set();
  const database = store.database;
  database.projections.ensure(['questions', 'documents', 'papers', 'attempts', 'study', 'reviews']);
  return new Set(database.all(database.query.selectFrom('asset_references').select('asset_id').distinct().where(database.expressions.idInJson('asset_id', [...wanted]))).map(row => row.asset_id));
}
export function assetIsReferenced(store: Store, aid: string): boolean {
  return referencedAssetIds(store, new Set([aid])).has(aid);
}
export function registerAssetRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/assets', async request => {
    const query = parse(z.object({ ...paginationFields }).strict(), request.query);
    const paged = query.page !== undefined || query.pageSize !== undefined, page = query.page ?? 1, pageSize = query.pageSize ?? 20;
    // Binary payloads do not belong in a file picker. Project them out before
    // crossing the native/WASM SQLite boundary, and only deserialize this page.
    const database = store.database, expressions = database.expressions;
    let selection = database.query.selectFrom('assets as a').select(expressions.jsonWithout('a.data', ['dataBase64']).as('data')).orderBy(expressions.field('a.data', 'createdAt'), 'desc').orderBy(expressions.rowOrder('a'), 'asc');
    if (paged) selection = selection.limit(pageSize).offset((page - 1) * pageSize);
    const rows = database.all(selection);
    const metadata = rows.map(row => JSON.parse(row.data) as AssetMetadata), references = referencedAssetIds(store, new Set(metadata.map(record => record.id)));
    const items = metadata.map(record => ({ ...record, referenced: references.has(record.id) }));
    return paged ? { items, total: Number(database.one(database.query.selectFrom('assets').select(eb => eb.fn.countAll<number>().as('total')))!.total), page, pageSize } : items;
  });
  app.post('/api/assets', async (request, reply) => {
    const input = parse(assetInputSchema, request.body); const bytes = decodeAssetBase64(input.dataBase64); const dimensions = validateAssetBytes(bytes, input.mimeType, getSettings(store));
    const record: AssetRecord = { ...input, filename: sanitizeAssetFilename(input.filename), ...dimensions, id: makeId('asset'), sizeBytes: bytes.length, createdAt: now() };
    store.insert('assets', record.id, record); return reply.code(201).send(assetMetadata(record));
  });
  app.get('/api/assets/:id/data', async request => store.require<AssetRecord>('assets', getId(request)));
  app.get('/api/assets/:id/content', async (request, reply) => {
    const record = store.require<AssetRecord>('assets', getId(request));
    return reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(record.filename)}`).type(record.mimeType).send(decodeAssetBase64(record.dataBase64));
  });
  app.get('/api/assets/:id', async request => assetMetadata(store.require<AssetRecord>('assets', getId(request))));
  app.delete('/api/assets/:id', async request => {
    const aid = getId(request); store.require('assets', aid);
    if (assetIsReferenced(store, aid)) fail(409, 'ASSET_IN_USE', '文件仍被题目、学习资料、笔记或历史练习快照引用，请保留文件以便查看和迁移');
    store.remove('assets', aid); return { ok: true, deleted: aid };
  });
}
