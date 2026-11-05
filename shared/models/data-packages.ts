import type { ConfigurationPreview } from './configuration.js';

export const dataPackageKinds = [
  'share',
  'migration',
  'configuration',
  'question-template',
  'question-update',
  'sqlite-backup',
] as const;
export type DataPackageKind = (typeof dataPackageKinds)[number];
export interface DataPackageFile {
  filename: string;
  mimeType: 'application/zip';
  dataBase64: string;
  byteLength: number;
}
export interface DataPackageCount {
  added: number;
  reused: number;
  remapped: number;
  skipped: number;
}
export interface DataPackagePreview {
  kind: DataPackageKind;
  title: string;
  fingerprint: string;
  counts: Record<string, DataPackageCount>;
  warnings: string[];
  details?: ConfigurationPreview;
  questions?: Array<{ id: string; title: string; status: 'pending' | 'reused' }>;
}
export interface DataPackageImportResult extends DataPackagePreview {
  ok: true;
  result: unknown;
}
