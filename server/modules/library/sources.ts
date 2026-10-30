import { createHash } from 'node:crypto';
import type {
  DocumentCitation,
  DocumentVersion,
  DocumentSourceView,
  DocumentRelatedQuestion,
} from '../../../shared/models/document-citations.js';
import type { DocumentRecord, Question } from '../../../shared/models/types.js';
import type { Paged } from '../../../shared/utils/pagination.js';
import type { Store } from '../../core/store.js';
import { now } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/service.js';
import { documentVersionSchema, relatedQuestionsQuerySchema } from './source-schema.js';
import type { z } from 'zod';

/** Content, not edit timestamps/titles, owns a locator's stable identity. */
export function documentContentVersion(
  document: Pick<DocumentRecord, 'format' | 'bodyMarkdown' | 'assetId'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        document.format || 'markdown',
        document.format === 'pdf' ? document.assetId : document.bodyMarkdown,
      ]),
    )
    .digest('hex');
}
export const documentVersionKey = (documentId: string, versionId: string) =>
  createHash('sha256')
    .update(JSON.stringify([documentId, versionId]))
    .digest('hex');
export function captureDocumentVersion(store: Store, document: DocumentRecord): DocumentVersion {
  const versionId = documentContentVersion(document),
    id = documentVersionKey(document.id, versionId);
  const existing = store.get<DocumentVersion>('document_versions', id);
  if (existing) return existing;
  const version: DocumentVersion = {
    id,
    documentId: document.id,
    versionId,
    title: document.title,
    format: document.format || 'markdown',
    bodyMarkdown: document.bodyMarkdown,
    assetId: document.assetId || null,
    fileName: document.fileName || null,
    createdAt: now(),
  };
  store.insert('document_versions', id, version);
  return version;
}
export function readDocumentSource(
  store: Store,
  documentId: string,
  versionId: string,
): DocumentSourceView {
  const document = store.get<DocumentRecord & { _archived?: boolean }>('documents', documentId);
  let version = store.get<DocumentVersion>(
    'document_versions',
    documentVersionKey(documentId, versionId),
  );
  // Legacy sources can be read without a write. Capture happens atomically on
  // linking or editing, so a read never changes the user's database.
  if (!version && document && documentContentVersion(document) === versionId)
    version = {
      id: documentVersionKey(documentId, versionId),
      documentId,
      versionId,
      title: document.title,
      format: document.format || 'markdown',
      bodyMarkdown: document.bodyMarkdown,
      assetId: document.assetId || null,
      fileName: document.fileName || null,
      createdAt: document.updatedAt || now(),
    };
  if (!version)
    fail(
      404,
      'DOCUMENT_SOURCE_UNAVAILABLE',
      '引用的资料版本未在本机保存，可在题目编辑中重新关联原文',
    );
  return {
    ...version!,
    currentVersionId: document ? documentContentVersion(document) : null,
    currentTitle: document?.title || null,
    archived: !document || !!document._archived,
  };
}
export function validateCitationLocation(version: DocumentVersion, citation: DocumentCitation) {
  if (version.format === 'markdown') {
    if (citation.pageStart !== undefined)
      fail(400, 'SOURCE_LOCATION_INVALID', 'Markdown资料请使用原文段落定位');
    if (citation.endOffset !== undefined && citation.endOffset > version.bodyMarkdown.length)
      fail(400, 'SOURCE_LOCATION_INVALID', '原文段落超出资料长度');
    const source =
      citation.startOffset !== undefined
        ? version.bodyMarkdown.slice(citation.startOffset, citation.endOffset)
        : version.bodyMarkdown;
    if (citation.excerpt && !source.includes(citation.excerpt))
      fail(400, 'SOURCE_EXCERPT_MISMATCH', '引用摘录不在选定原文范围内，请核对后保存');
  } else if (citation.startOffset !== undefined)
    fail(400, 'SOURCE_LOCATION_INVALID', 'PDF资料请使用文件页码定位');
}
/** Called only from write transactions. Models never choose source identities. */
export function validateDocumentCitations(
  store: Store,
  question: Pick<Question, 'documentLinks'>,
  capture = false,
  cache?: Map<string, DocumentVersion>,
) {
  for (const citation of question.documentLinks || []) {
    if (!citation.documentId || !citation.versionId) continue;
    const key = documentVersionKey(citation.documentId, citation.versionId);
    const version =
      cache?.get(key) ||
      store.get<DocumentVersion>('document_versions', key) ||
      readDocumentSource(store, citation.documentId, citation.versionId);
    cache?.set(key, version);
    validateCitationLocation(version, citation);
    if (
      capture &&
      !store.database.one(
        store.database.query
          .selectFrom('document_versions')
          .select('id')
          .where('id', '=', version.id),
      )
    ) {
      store.insert('document_versions', version.id, parse(documentVersionSchema.strip(), version));
    }
  }
}
export function validateStoredDocumentVersion(store: Store, raw: unknown): DocumentVersion {
  const version = parse(documentVersionSchema, raw);
  if (
    version.id !== documentVersionKey(version.documentId, version.versionId) ||
    version.versionId !== documentContentVersion(version)
  )
    fail(400, 'DOCUMENT_VERSION_INVALID', '资料版本摘要或身份无效');
  validateAssetReferences(store, version);
  return version;
}
export function relatedDocumentQuestions(
  store: Store,
  documentId: string,
  input: z.infer<typeof relatedQuestionsQuerySchema>,
): Paged<DocumentRelatedQuestion> {
  const database = store.database,
    expr = database.expressions;
  if (
    !database.one(
      database.query.selectFrom('documents').select('id').where('id', '=', documentId),
    ) &&
    !database.one(
      database.query
        .selectFrom('document_versions')
        .select('id')
        .where(expr.field('data', 'documentId'), '=', documentId)
        .limit(1),
    )
  )
    fail(404, 'NOT_FOUND', '资料不存在');
  database.projections.ensure(['questions']);
  let selected = database.query
    .selectFrom('question_read_model as q')
    .where(expr.documentCitationMatch('q.data', documentId, input.versionId, input.pageNumber));
  if (input.search)
    selected = selected.where(expr.unicodeContains(expr.field('q.data', 'title'), input.search));
  const total = Number(
    database.one(selected.select((eb) => eb.fn.countAll<number>().as('total')))!.total,
  );
  const pageSize = input.pageSize ?? 20,
    page = Math.min(input.page ?? 1, Math.max(1, Math.ceil(total / pageSize)));
  const items = database
    .all(
      selected
        .select([
          'q.id',
          expr.field<string>('q.data', 'title').as('title'),
          expr.field<string>('q.data', 'type').as('type'),
          expr.field<string>('q.data', 'status').as('status'),
          expr.field<string>('q.data', 'documentLinks').as('links'),
        ])
        .orderBy('q.id')
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    )
    .map(({ links, ...item }) => ({
      ...item,
      documentLinks: (JSON.parse(links) as DocumentCitation[]).filter(
        (link) =>
          link.documentId === documentId &&
          (!input.versionId || link.versionId === input.versionId),
      ),
    }));
  return { items, total, page, pageSize };
}
