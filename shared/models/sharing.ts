import type { AssetRecord } from '../assets/assets.js';
import type { Domain, Category, Tag, Question, Paper, QuestionBank } from './types.js';

export type ShareKind = 'questions' | 'paper' | 'bank';
export interface ShareSelection { kind: ShareKind; id?: string; ids?: string[]; filters?: Record<string, unknown> }
export interface SharedPaper extends Paper { snapshot: Question[] }
/** Public content only: no drafts, attempts, notes, credentials or settings. */
export interface SharePackage {
  format: 'learning-share'; schemaVersion: 1; exportedAt: string; title: string;
  domains: Domain[]; categories: Category[]; tags: Tag[]; assets: AssetRecord[];
  questions: Question[]; papers: SharedPaper[]; questionBanks: QuestionBank[];
}
export interface ShareCounts { added: number; reused: number; remapped: number }
export interface SharePreview { title: string; counts: Record<string, ShareCounts>; questions: Array<{ id: string; title: string; status: 'pending' | 'reused' }>; warnings: string[]; fingerprint: string }
