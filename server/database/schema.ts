/** Persisted document tables. Names are a closed set, never taken from requests. */
export const recordTables = ['pdf_caches', 'pdf_pages', 'pdf_jobs', 'document_versions', 'domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'attempts', 'study', 'study_parts', 'learning_results', 'question_history', 'reviews', 'review_cards', 'review_events', 'question_banks', 'settings', 'assets', 'paper_drafts', 'document_drafts', 'question_drafts', 'question_revisions', 'ai_workspace_drafts', 'daily_pushes', 'ai_settings', 'ai_runs', 'ai_import_jobs', 'question_feedback', 'quality_scans', 'quality_issues', 'quality_fingerprints', 'focus_sessions','learning_days','learning_task_results'] as const;
export type RecordTable = typeof recordTables[number];
export interface DocumentRow { id: string; data: string }
export type AtlasDatabase = { [K in RecordTable]: DocumentRow } & {
  question_import_index: {id:string;content_hash:string;prompt_hash:string;title:string;title_key:string;vocab_key:string;type:string;status:string;source_stamp:string;tokens:string};
  question_import_terms: {term:string;question_id:string};
  question_import_pending: {source_table:string;source_id:string};
  metadata: { key: string; value: string };
  'atlas_question_order': { id: string; ordinal: number };
  question_read_model: DocumentRow & { search_text: string; title_key: string };
  paper_read_model: DocumentRow;
  document_read_model: DocumentRow & { search_text: string; source_order: number };
  search_read_model: { key: string; source_table: string; source_id: string; kind: string; entity_id: string; question_id: string | null; data: string; id_key: string; title_key: string; content_key: string; search_text: string; content: string; status: string; archived: number; updated_at: string };
  search_projection_pending: { source_table: string; source_id: string };
  projection_pending: { source_table: string; source_id: string };
  startup_validation_pending: { source_table: string; source_id: string };
  asset_references: { source_table: string; source_id: string; asset_id: string };
};
