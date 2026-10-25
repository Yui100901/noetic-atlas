import { z } from 'zod';
import type { DocumentDraftState } from '../../../shared/models/document-drafts.js';
import type { Store } from '../../core/store.js';
import { documentSchema, fail, id } from '../../core/validation.js';
import { getSettings } from '../settings/service.js';
import { validateAssetReferences } from '../assets/routes.js';

const stamp = z.string().datetime({ offset: true });
export const documentDraftStateSchema = documentSchema.omit({ id: true, updatedAt: true }).extend({
  title: z.string().max(300), kind: z.string().max(300),
}).strict();
export const documentDraftSchema = z.object({
  id, documentId: id.nullable(), baseDocumentUpdatedAt: stamp.nullable(), state: documentDraftStateSchema,
  createdAt: stamp, updatedAt: stamp,
}).strict().superRefine((draft, context) => {
  if (draft.documentId === null && draft.baseDocumentUpdatedAt !== null) context.addIssue({ code: 'custom', path: ['baseDocumentUpdatedAt'], message: '新建资料草稿不能有原资料版本' });
  if (Date.parse(draft.updatedAt) < Date.parse(draft.createdAt)) context.addIssue({ code: 'custom', path: ['updatedAt'], message: '草稿更新时间不可早于创建时间' });
});
export const documentDraftQuerySchema = z.object({ documentId: id.optional() }).strict();
export const createDocumentDraftSchema = z.object({ documentId: id.nullable(), baseDocumentUpdatedAt: stamp.nullable(), state: documentDraftStateSchema }).strict().superRefine((value, context) => {
  if (value.documentId === null && value.baseDocumentUpdatedAt !== null) context.addIssue({ code: 'custom', path: ['baseDocumentUpdatedAt'], message: '新建资料草稿不能有原资料版本' });
});
export const updateDocumentDraftSchema = z.object({ expectedUpdatedAt: stamp, state: documentDraftStateSchema }).strict();
export const deleteDocumentDraftSchema = z.object({ expectedUpdatedAt: stamp }).strict();
export const publishDocumentDraftSchema = z.object({ expectedUpdatedAt: stamp, asNew: z.boolean().optional() }).strict();

export function validateDocumentDraftState(store: Store, state: DocumentDraftState, migration = false) {
  store.validateRefs(state);
  const limits = migration ? { maxDocumentMiB: 50, maxImageMiB: 100 } : getSettings(store);
  if (new TextEncoder().encode(state.bodyMarkdown).length > limits.maxDocumentMiB * 1024 * 1024) fail(413, 'DOCUMENT_TOO_LARGE', '资料草稿内容超过系统配置允许的大小');
  validateAssetReferences(store, state, limits);
}
