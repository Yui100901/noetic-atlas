import { useEffect, useRef } from 'react';

const HISTORY_INDEX = 'noeticAtlasNavigationIndex';
let hashGuard: ((event: HashChangeEvent) => boolean) | null = null;
/** The router consults the active reader before changing React's route state.
 * This is explicit so Window event-listener registration order cannot unmount
 * the editor before its unsaved-change check runs. */
export const allowHashNavigation = (event: HashChangeEvent): boolean => hashGuard?.(event) ?? true;
export function navigationIndex(): number | null {
  const value = window.history.state?.[HISTORY_INDEX];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function markNavigationEntry(fallback: number): number {
  const current = navigationIndex();
  if (current !== null) return current;
  const state = window.history.state;
  window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), [HISTORY_INDEX]: fallback }, '');
  return fallback;
}

/** A redirect replaces the current entry; it must not consume a new index. */
export function replaceHashRoute(hash: string): void {
  if (window.location.hash === hash) return;
  const oldURL = window.location.href;
  window.history.replaceState(window.history.state, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
}

/** Capture before the hash router unmounts the editor. Indexed entries let a
 * cancelled Back/Forward return to the same entry without overwriting history. */
export function useNavigationGuard(options: { pending: () => boolean; saving: () => boolean; confirmLeave: () => boolean; onBusy: () => void }) {
  const latest = useRef(options); latest.current = options;
  useEffect(() => {
    let known = window.location.hash, index = markNavigationEntry(0), leaving = false, restoring = false;
    const blocked = () => latest.current.pending() || latest.current.saving();
    const allowed = () => {
      if (latest.current.saving()) { latest.current.onBusy(); return false; }
      return latest.current.confirmLeave();
    };
    const click = (event: MouseEvent) => {
      if (leaving || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !blocked()) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.href === window.location.href || target.origin === location.origin && target.pathname === location.pathname && target.search === location.search && !target.hash.startsWith('#/')) return;
      if (!allowed()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      leaving = true;
    };
    const hash = (event: HashChangeEvent): boolean => {
      const next = window.location.hash;
      if (restoring) {
        event.stopImmediatePropagation(); restoring = false;
        return false;
      }
      if (next === known) return true;
      const nextIndex = navigationIndex();
      if (leaving || !blocked() || allowed()) {
        leaving = true; known = next; index = nextIndex ?? index + 1;
        return true;
      }
      event.stopImmediatePropagation();
      if (nextIndex !== null && nextIndex !== index) {
        restoring = true; window.history.go(index - nextIndex);
      } else {
        window.history.replaceState(window.history.state, '', known);
      }
      return false;
    };
    const unload = (event: BeforeUnloadEvent) => { if (!leaving && blocked()) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('click', click, true);
    hashGuard = hash;
    window.addEventListener('beforeunload', unload);
    return () => {
      document.removeEventListener('click', click, true);
      if (hashGuard === hash) hashGuard = null;
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
}
