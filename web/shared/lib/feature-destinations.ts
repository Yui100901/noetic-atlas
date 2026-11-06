/** Old bookmarks resolve to the feature that now owns the operation. Never
 * use a supplied destination or lose the task/run context during relocation. */
export function relocatedAiHref(query: string | URLSearchParams): string {
  const params = new URLSearchParams(query);
  const tab = params.get('tab') || 'paper';
  params.delete('tab');
  const destination =
    tab === 'history'
      ? '#/analytics'
      : tab === 'import' || tab === 'documents'
        ? '#/sharing'
        : '#/papers/new/ai';
  if (tab === 'history') {
    params.set('tab', 'ai');
    if (!['mode', 'from', 'to', 'before'].some((key) => params.has(key))) params.set('mode', 'all');
  } else if (tab === 'import' || tab === 'documents') params.set('tab', tab);
  const suffix = params.toString();
  return destination + (suffix ? '?' + suffix : '');
}
