/** Root IDs may themselves contain ::. Exact roots win, followed by the
 * longest valid prefix. Scan bounded IDs instead of every selected question. */
function rootFromSet(id: string, roots: Set<string>): string | undefined {
  if (roots.has(id)) return id;
  let index = id.lastIndexOf('::');
  while (index > 0) {
    const root = id.slice(0, index);
    if (roots.has(root)) return root;
    index = id.lastIndexOf('::', index - 1);
  }
}
export function rubricRoot(id: string, roots: string[]): string | undefined {
  return rootFromSet(id, new Set(roots));
}
export function selectedRubrics(values: Record<string, string>, roots: string[]) {
  const selected = new Set(roots);
  return Object.fromEntries(
    Object.entries(values).filter(([id]) => rootFromSet(id, selected) !== undefined),
  );
}
