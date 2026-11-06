import type {
  ImportDedupDecision,
  ImportDedupItem,
  ImportDedupPreview,
} from '../../../shared/models/import-dedup';

export function validImportDecisions(
  preview: ImportDedupPreview,
  decisions: ImportDedupDecision[],
) {
  const items = new Map(
    preview.items.filter((item) => item.kind === 'similar').map((item) => [item.key, item]),
  );
  return decisions.filter((decision) => {
    const item = items.get(decision.key);
    return (
      !!item &&
      (decision.action === 'both' ||
        item.candidates.some((candidate) => candidate.id === decision.targetId))
    );
  });
}

export function unresolvedImportItems(
  preview: ImportDedupPreview,
  decisions: ImportDedupDecision[],
) {
  const resolved = new Set(validImportDecisions(preview, decisions).map((item) => item.key));
  return preview.items.filter((item) => item.kind === 'similar' && !resolved.has(item.key));
}

/** Bulk operations never overwrite an existing choice or silently replace a
 * question. Replacing requires selecting a specific source and destination. */
export function bulkImportDecision(
  preview: ImportDedupPreview,
  decisions: ImportDedupDecision[],
  action: 'keep' | 'both',
  keys?: string[],
) {
  const next = [...validImportDecisions(preview, decisions)];
  const selected = keys ? new Set(keys) : undefined;
  for (const item of unresolvedImportItems(preview, decisions)) {
    if (selected && !selected.has(item.key)) continue;
    const targetId = item.candidates[0]?.id;
    if (action === 'keep' && !targetId) continue;
    next.push({ key: item.key, action, ...(action === 'keep' ? { targetId } : {}) });
  }
  return next;
}

export function selectImportDecision(
  decisions: ImportDedupDecision[],
  item: ImportDedupItem,
  action: ImportDedupDecision['action'] | null,
  targetId?: string,
) {
  const rest = decisions.filter((decision) => decision.key !== item.key);
  if (!action) return rest;
  if (action !== 'both' && !item.candidates.some((candidate) => candidate.id === targetId))
    return rest;
  return [...rest, { key: item.key, action, ...(action !== 'both' ? { targetId } : {}) }];
}
