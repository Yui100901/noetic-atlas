import type { Category, DocumentRecord } from '../../../shared/models/types.js';
import { documentDomainIds, type DocumentListItem } from '../../../shared/models/library.js';
import { Store, makeId, nextStamp, now } from '../../core/store.js';
import { documentSchema, fail, parse } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/service.js';
import { getSettings } from '../settings/service.js';
import { documentListQuerySchema, documentSelection, orderedDocuments } from './list.js';

import type { z } from 'zod';

export function normalizeDocument<T extends Omit<DocumentRecord, 'bodyMarkdown'>>(
  store: Store,
  value: T,
  categories?: Category[],
): T {
  return {
    ...value,
    format: value.format || 'markdown',
    assetId: value.assetId || null,
    fileName: value.fileName || null,
    domainIds: documentDomainIds(value, categories || store.all<Category>('categories')),
    author: value.author || '',
    publisher: value.publisher || '',
    publishedYear: value.publishedYear || '',
    description: value.description || '',
  };
}
export function validateDocument(store: Store, document: DocumentRecord) {
  store.validateRefs(document);
  const settings = getSettings(store);
  if (
    new TextEncoder().encode(document.bodyMarkdown).length >
    settings.maxDocumentMiB * 1024 * 1024
  )
    fail(413, 'DOCUMENT_TOO_LARGE', '资料内容超过系统配置允许的大小');
  validateAssetReferences(store, document, settings);
}
type DocumentQuery = z.infer<typeof documentListQuerySchema>;

export function listDocuments(store: Store, input: DocumentQuery) {
  const categories = store.all<Category>('categories');
  const selected = documentSelection(store, input, categories),
    ordered = orderedDocuments(selected, store);
  const paged = input.page !== undefined || input.pageSize !== undefined,
    page = input.page ?? 1,
    pageSize = input.pageSize ?? 20;
  const total = paged
    ? Number(
        store.database.one(selected.select((eb) => eb.fn.countAll<number>().as('total')))!.total,
      )
    : 0;
  const full = ordered
    .innerJoin('documents as content', 'content.id', 'd.id')
    .select('content.data');
  const rows = store.database.all(
    paged ? full.limit(pageSize).offset((page - 1) * pageSize) : full,
  );
  const items = rows.map((row) =>
    normalizeDocument(store, JSON.parse(row.data) as DocumentRecord, categories),
  );
  return paged ? { items, total, page, pageSize } : items;
}

export function documentPage(store: Store, input: DocumentQuery) {
  const categories = store.all<Category>('categories');
  const selected = documentSelection(store, input, categories);
  const total = Number(
    store.database.one(selected.select((eb) => eb.fn.countAll<number>().as('total')))!.total,
  );
  const pageSize = input.pageSize ?? 20,
    page = Math.min(input.page ?? 1, Math.max(1, Math.ceil(total / pageSize)));
  // Sort identities before decoding card metadata. Warm reads never download
  // book bodies; dirty projections refresh only when source records change.
  const ids = store.database
    .all(
      orderedDocuments(selected, store)
        .select('d.id')
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    )
    .map((row) => row.id);
  const rows = ids.length
    ? store.database.all(
        orderedDocuments(
          store.database.query.selectFrom('document_read_model as d').where('d.id', 'in', ids),
          store,
        ).select('d.data as metadata'),
      )
    : [];
  const items = rows.map((row) =>
    normalizeDocument(store, JSON.parse(row.metadata) as DocumentListItem, categories),
  );
  return { items, total, page, pageSize };
}

export function documentKinds(store: Store) {
  store.database.projections.ensure(['documents']);
  const { query, expressions } = store.database;
  return store.database
    .all(
      query
        .selectFrom('document_read_model')
        .select(expressions.field('data', 'kind').as('kind'))
        .distinct()
        .where(expressions.booleanOrFalse(expressions.field('data', '_archived')), '=', 0),
    )
    .map((row) => String(row.kind))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function getDocument(store: Store, documentId: string) {
  const document = store.require<DocumentRecord & { _archived?: boolean }>('documents', documentId);
  if (document._archived) fail(404, 'NOT_FOUND', '资料已归档');
  return normalizeDocument(store, document);
}

export function createDocument(store: Store, body: unknown) {
  const input = parse(documentSchema, body);
  const document = normalizeDocument(store, {
    ...input,
    id: input.id || makeId('doc'),
    updatedAt: now(),
  } as DocumentRecord);
  validateDocument(store, document);
  store.insert('documents', document.id, document);
  return document;
}

export function updateDocument(store: Store, documentId: string, body: unknown) {
  const previous = store.require<DocumentRecord>('documents', documentId),
    input = parse(documentSchema, body);
  if (input.id && input.id !== documentId) fail(400, 'ID_IMMUTABLE', 'ID 不能在编辑时更换');
  if (input.updatedAt && input.updatedAt !== previous.updatedAt)
    fail(409, 'DOCUMENT_VERSION_CONFLICT', '资料已更新，请刷新后再编辑');
  const document = normalizeDocument(store, {
    ...input,
    id: documentId,
    updatedAt: nextStamp(previous.updatedAt),
  } as DocumentRecord);
  validateDocument(store, document);
  store.put('documents', documentId, document);
  return document;
}

export function archiveDocument(store: Store, documentId: string) {
  const document = store.require<DocumentRecord>('documents', documentId);
  store.put('documents', documentId, {
    ...document,
    _archived: true,
    updatedAt: nextStamp(document.updatedAt),
  });
  return { ok: true };
}
