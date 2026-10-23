import type { PaperDraft } from '../../../shared/practice/paper-drafts.js';
import type { Store } from '../../core/store.js';

export function paperDraftRetentionCandidates(store: Store, maximum: number, preserveId?: string) {
  const groups = new Map<string, PaperDraft[]>();
  for (const draft of store.all<PaperDraft>('paper_drafts')) groups.set(draft.context,[...(groups.get(draft.context)||[]),draft]);
  return [...groups.values()].flatMap(group => {
    group.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id));
    const preserved = group.find(d=>d.id===preserveId);
    return (preserved?[preserved,...group.filter(d=>d.id!==preserveId)]:group).slice(maximum);
  });
}
