import { createHash } from 'node:crypto';
import type { Paper, Question, QuestionBank } from '../../../shared/models/types.js';
import type { PaperDraft } from '../../../shared/practice/paper-drafts.js';
import { type Store, now } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { normalizeScoring } from '../practice/scoring.js';
import { QUICK_PAPER_ID, type StoredPaper } from '../practice/service.js';

/** Legacy collections only contained references. Convert every reference into
 * one frozen question set, retaining its order, including unpublished members.
 * A private origin marker makes repeat imports idempotent after local edits. */
export function legacyBankPaper(bank: QuestionBank, questions: Question[], paperId = bank.id): StoredPaper {
  if (questions.length !== bank.questionIds.length || questions.some((question, index) => question.id !== bank.questionIds[index])) fail(400, 'INVALID_LEGACY_BANK', '旧题库集合引用或顺序不完整');
  const stamp = now();
  return {
    id: paperId, legacyBankId: bank.id, title: bank.name, description: bank.description || '',
    mode: 'manual', questionIds: [...bank.questionIds], questionCount: questions.length,
    organization: 'other', domainId: null, filters: null, version: 1,
    archived: !questions.length || questions.some(question => question.status !== 'published'),
    snapshot: questions, scoring: normalizeScoring(questions, { enabled: false }),
    createdAt: bank.createdAt || stamp, updatedAt: bank.updatedAt || stamp,
  };
}

export function legacyBankPaperId(store: Store, bankId: string): { id: string; existing: boolean } {
  const converted = store.all<Paper>('papers').find(paper => paper.legacyBankId === bankId);
  if (converted) return { id: converted.id, existing: true };
  const reserved = ['new', 'preview', QUICK_PAPER_ID];
  if (!reserved.includes(bankId) && !store.get('papers', bankId)) return { id: bankId, existing: false };
  const base = `legacy-bank-${createHash('sha256').update(bankId).digest('hex').slice(0, 24)}`;
  let candidate = base, suffix = 1;
  while (store.get('papers', candidate)) candidate = `${base}-${suffix++}`;
  return { id: candidate, existing: false };
}

function withoutBankFilter<T extends object>(filters: T): Omit<T, 'bankId'> {
  const { bankId: _obsolete, ...remaining } = filters as T & { bankId?: unknown };
  return remaining;
}

/** Also applies to old JSON before strict authoring-draft validation. */
export function cleanLegacyBankFilters(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const input = raw as Record<string, any>;
  return {
    ...input,
    ...(Array.isArray(input.papers) ? { papers: input.papers.map((paper: any) => paper && typeof paper === 'object' ? { ...paper, ...(paper.filters && typeof paper.filters === 'object' ? { filters: withoutBankFilter(paper.filters) } : {}) } : paper) } : {}),
    ...(Array.isArray(input.paperDrafts) ? { paperDrafts: input.paperDrafts.map((draft: any) => draft?.state && typeof draft.state === 'object' ? { ...draft, state: { ...draft.state, filters: withoutBankFilter(draft.state.filters || {}), random: withoutBankFilter(draft.state.random || {}) } } : draft) } : {}),
  };
}

/** One transaction covers creation, removal and obsolete filter cleanup. Never
 * split or truncate a large collection, nor rewrite existing attempt snapshots. */
export function migrateLegacyBanks(store: Store): number {
  return store.transaction(() => {
    let changed = 0;
    for (const bank of store.all<QuestionBank>('question_banks')) {
      const questions = bank.questionIds.map(qid => store.require<Question>('questions', qid));
      const target = legacyBankPaperId(store, bank.id);
      if (!target.existing) store.insert('papers', target.id, legacyBankPaper(bank, questions, target.id));
      store.remove('question_banks', bank.id);
      changed++;
    }
    for (const paper of store.all<Paper>('papers')) if (paper.filters && 'bankId' in paper.filters) {
      store.put('papers', paper.id, { ...paper, filters: withoutBankFilter(paper.filters as Record<string, unknown>) }); changed++;
    }
    for (const draft of store.all<PaperDraft>('paper_drafts')) {
      if (!('bankId' in draft.state.filters) && !('bankId' in draft.state.random)) continue;
      store.put('paper_drafts', draft.id, { ...draft, state: { ...draft.state, filters: withoutBankFilter(draft.state.filters), random: withoutBankFilter(draft.state.random) } }); changed++;
    }
    return changed;
  });
}
