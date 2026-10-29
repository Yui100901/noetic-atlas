import { useEffect, useRef } from 'react';
import { registerAsyncHashGuard, markNavigationEntry, navigationIndex } from './navigation-guard';

/** A write must finish before the router unmounts its owner. This guard is
 * separate from discard-confirmation guards: successful autosave adds no dialog.
 * Failed saves leave the current component mounted so its input/error survives. */
export function useSaveBeforeNavigation(options: {
  pending: () => boolean;
  save: () => Promise<boolean>;
}) {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    let known = window.location.hash,
      index = markNavigationEntry(0),
      leaving = false,
      disposed = false;
    let operation = false,
      restoring: Promise<void> | null = null,
      restored: (() => void) | null = null;
    const run = async (navigate: () => void) => {
      if (operation || disposed) return;
      operation = true;
      try {
        const saved = await latest.current.save();
        if (restoring) await restoring;
        if (saved && !disposed) {
          leaving = true;
          navigate();
        }
      } catch {
        /* The owner presents its save error; keep its input mounted. */
      } finally {
        operation = false;
      }
    };
    const click = (event: MouseEvent) => {
      if (
        leaving ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !latest.current.pending()
      )
        return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const target = new URL(anchor.href, window.location.href);
      if (
        target.href === location.href ||
        (target.origin === location.origin &&
          target.pathname === location.pathname &&
          target.search === location.search &&
          !target.hash.startsWith('#/'))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void run(() => {
        window.location.href = target.href;
      });
    };
    const hash = (event: HashChangeEvent): boolean => {
      const next = window.location.hash;
      if (restored) {
        event.stopImmediatePropagation();
        const done = restored;
        restored = null;
        restoring = null;
        done();
        return false;
      }
      if (next === known) return true;
      const nextIndex = navigationIndex();
      if (leaving || !latest.current.pending()) {
        leaving = true;
        known = next;
        index = nextIndex ?? index + 1;
        return true;
      }
      event.stopImmediatePropagation();
      if (nextIndex !== null && nextIndex !== index) {
        const delta = nextIndex - index;
        restoring = new Promise((resolve) => {
          restored = resolve;
        });
        window.history.go(-delta);
        void run(() => window.history.go(delta));
      } else {
        window.history.replaceState(window.history.state, '', known);
        void run(() => {
          window.location.hash = next;
        });
      }
      return false;
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!leaving && latest.current.pending()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const unregister = registerAsyncHashGuard(hash);
    document.addEventListener('click', click, true);
    window.addEventListener('beforeunload', unload);
    return () => {
      disposed = true;
      restored?.();
      unregister();
      document.removeEventListener('click', click, true);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
}
