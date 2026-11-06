import type { ShareSelection } from './sharing.js';

export interface DataPackageExportInput {
  kind: 'share' | 'migration' | 'configuration' | 'question-template' | 'question-update';
  selection?: ShareSelection;
  includeAi?: boolean;
  ids?: string[];
}
/** ZIP compression depends on the content. Preview reports a safe STORE-size
 * upper bound instead of pretending to know the eventual compression ratio. */
export interface ExportPreflight {
  allowed: boolean;
  questionCount: number;
  estimatedExpandedBytes: number;
  estimatedZipBytes: number;
  attachmentBytes: number;
  estimatedFiles: number;
  maxQuestions: number;
  estimateIsUpperBound: true;
  reasons: string[];
  recommendations: Array<{ label: string; href: string }>;
}
