/** Web visibility and native Activity visibility are independent signals. */
let active = true;
const listeners = new Set<(active: boolean) => void>();
export function isApplicationActive(): boolean {
  return active;
}
export function setApplicationActive(value: boolean): void {
  if (active === value) return;
  active = value;
  for (const listener of [...listeners]) listener(value);
}
export function onApplicationStateChange(listener: (active: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

interface AppStateSource {
  addListener(
    event: 'appStateChange',
    listener: (state: { isActive: boolean }) => void,
  ): Promise<{ remove(): Promise<void> }>;
  getState(): Promise<{ isActive: boolean }>;
}
/** Subscribe first so a delayed initial read cannot revive an already paused
 * Activity. The returned cleanup also rejects callbacks queued before removal. */
export async function connectApplicationState(
  source: AppStateSource,
): Promise<() => Promise<void>> {
  let changed = false,
    disposed = false;
  const handle = await source.addListener('appStateChange', (state) => {
    changed = true;
    if (!disposed) setApplicationActive(state.isActive);
  });
  try {
    const initial = await source.getState();
    if (!changed && !disposed) setApplicationActive(initial.isActive);
  } catch {
    /* Future native events still work if the initial query fails. */
  }
  return async () => {
    disposed = true;
    await handle.remove();
  };
}
