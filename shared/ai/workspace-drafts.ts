/** Private, unfinished workspace snapshots. These are never shared as content. */
export const AI_WORKSPACE_DRAFT_KINDS = ['paper', 'import', 'documents', 'document-job'] as const;
export type AiWorkspaceDraftKind = typeof AI_WORKSPACE_DRAFT_KINDS[number];
export const AI_WORKSPACE_DRAFT_LIMIT = 3;
export const AI_WORKSPACE_DRAFT_MAX_BYTES = 24 * 1024 * 1024;
export interface AiWorkspaceDraft {
  id: string;
  kind: AiWorkspaceDraftKind;
  contextId: string | null;
  state: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
