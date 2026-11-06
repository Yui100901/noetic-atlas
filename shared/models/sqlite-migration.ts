/** SQLite migration snapshots preserve retained records and their relationships. */
export interface SQLiteMigrationSelection {
  domainIds?: string[];
}
export interface SQLiteMigrationPreview {
  scope: 'all' | 'domains';
  domainIds: string[];
  fingerprint: string;
  counts: Record<string, number>;
  seedQuestions: number;
  dependencyQuestions: number;
  warnings: string[];
}
