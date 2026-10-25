import type { AiSettings } from '../ai/ai.js';
import type { SystemSettings } from './settings.js';

/** Portable preferences only; credentials and learning/content data never belong here. */
export interface ConfigurationExport {
  format: 'noetic-atlas-configuration';
  schemaVersion: 1;
  exportedAt: string;
  system: Omit<SystemSettings, 'id' | 'updatedAt'>;
  ai?: Omit<AiSettings, 'hasKey' | 'updatedAt'>;
}

export interface ConfigurationChange { key: string; before: unknown; after: unknown }
export interface ConfigurationRetention { drafts: number; history: number; authoring: number; total: number; questionHistory?:number; documentDrafts?:number }
export interface ConfigurationPreview {
  fingerprint: string;
  systemChanges: ConfigurationChange[];
  aiChanges: ConfigurationChange[];
  retention: ConfigurationRetention;
  warnings: string[];
  aiKey: { action: 'unchanged' | 'preserve' | 'clear' | 'missing'; message: string };
}
export interface ConfigurationImportResult {
  settings: SystemSettings;
  ai: AiSettings;
  retention: ConfigurationRetention;
}
