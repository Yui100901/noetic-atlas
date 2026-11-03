import type { QuestionStatus } from './types.js';

export type ContentExportPurpose = 'migration' | 'share';
export type ContentExportMode = 'combined' | 'per_domain';
export interface ContentExportSelection {
  domainIds: string[];
  purpose?: ContentExportPurpose;
  mode?: ContentExportMode;
  status?: QuestionStatus | 'all';
  collection?: 'all' | 'general' | 'personal';
}
export type ContentExportScope = Required<ContentExportSelection>;
export interface ContentExportDomain {
  id: string;
  name: string;
  questionCount: number;
}
export interface ContentExportLimits {
  maxQuestions: number;
  maxPackageBytes: number;
  /** Leaves room for the JSON import request wrapper below its HTTP body cap. */
  maxCombinedBytes: number;
  maxPartQuestions: number;
  maxPartBytes: number;
}
export interface ContentExportPreview {
  fingerprint: string;
  scope: ContentExportScope;
  /** All domains, counted for the current admission/collection scope. */
  domains: ContentExportDomain[];
  selectedDomains: ContentExportDomain[];
  questionCount: number;
  memberships: number;
  emptyDomainIds: string[];
  /** Source question bytes only, before detaching citations and adding files. */
  estimatedQuestionBytes: number;
  categories: number;
  tags: number;
  limits: ContentExportLimits;
  warnings: string[];
}
export interface ContentExportBuildInput extends ContentExportSelection {
  expectedFingerprint: string;
}
export interface ContentExportFile {
  filename: string;
  mimeType: 'application/json' | 'application/zip';
  dataBase64: string;
  byteLength: number;
  summary: {
    questionCount: number;
    domainCount: number;
    /** Number of importable JSON files, excluding archive documentation. */
    fileCount: number;
    purpose: ContentExportPurpose;
    mode: ContentExportMode;
  };
}
