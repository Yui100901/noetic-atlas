import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Attempt } from '../../../shared/models/types';
import { examExpired } from '../../../shared/practice/attempt-timing';
import { href, send } from '../../shared/lib/api';
import { ErrorNotice, Loading } from '../../shared/ui/components';
import './exam-guard.css';

const EVENT = 'noetic-atlas-exam-state';
const STORAGE_KEY = 'noetic-atlas-active-exam';
export function notifyExamState(attempt: Attempt): void {
  if (attempt.practiceMode !== 'exam') return;
  try { if (attempt.status === 'in_progress') localStorage.setItem(STORAGE_KEY, attempt.id); else localStorage.removeItem(STORAGE_KEY); } catch { /* The database remains authoritative when storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: attempt.status === 'in_progress' ? attempt : null }));
}

/** A global wrapper is essential: a guard mounted only on the answer page is
 * removed by the very navigation it is supposed to prevent. */
export function ExamNavigationGuard({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<Attempt | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [blocked, setBlocked] = useState(false);
  const activeRef = useRef<Attempt | null>(null), syncing = useRef(false), mounted = useRef(true);
  const install = useCallback((attempt: Attempt | null) => { activeRef.current = attempt; setActive(attempt); if (!attempt) setBlocked(false); }, []);
  const sync = useCallback(async () => {
    if (syncing.current) return; syncing.current = true;
    try {
      const result = await send<{ attempt: Attempt | null }>('/api/exams/sync', 'POST');
      if (mounted.current) { install(result.attempt); setError(''); }
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
    finally { syncing.current = false; if (mounted.current) setLoading(false); }
  }, [install]);
  useEffect(() => {
    mounted.current = true; void sync();
    const changed = (event: Event) => { install((event as CustomEvent<Attempt | null>).detail); };
    const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) void sync(); };
    const visibility = () => { if (document.visibilityState === 'visible') void sync(); };
    const interval = setInterval(() => { if (activeRef.current && examExpired(activeRef.current)) void sync(); }, 1000);
    window.addEventListener(EVENT, changed); window.addEventListener('storage', storage); document.addEventListener('visibilitychange', visibility);
    return () => { mounted.current = false; clearInterval(interval); window.removeEventListener(EVENT, changed); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', visibility); };
  }, [install, sync]);
  useEffect(() => {
    if (!active) return;
    const lockedHref = href('attempts', active.id);
    const restore = () => {
      if (window.location.hash !== lockedHref) {
        setBlocked(true); window.history.replaceState(null, '', lockedHref);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }
    };
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!target) return;
      const destination = target.getAttribute('href') || '';
      if (destination.startsWith('#/') && destination !== lockedHref) { event.preventDefault(); event.stopPropagation(); setBlocked(true); }
    };
    const submit = (event: Event) => { if (event.target instanceof Element && event.target.matches('.top-search')) { event.preventDefault(); event.stopPropagation(); setBlocked(true); } };
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('hashchange', restore); document.addEventListener('click', click, true); document.addEventListener('submit', submit, true); window.addEventListener('beforeunload', unload);
    document.body.classList.add('exam-active'); restore();
    return () => { window.removeEventListener('hashchange', restore); document.removeEventListener('click', click, true); document.removeEventListener('submit', submit, true); window.removeEventListener('beforeunload', unload); document.body.classList.remove('exam-active'); };
  }, [active?.id]);
  if (loading) return <div className="exam-loading"><Loading text="正在核对考试状态…" /></div>;
  if (error && !active) return <div className="exam-loading"><ErrorNotice message={`无法核对考试状态：${error}`} retry={() => void sync()} /></div>;
  return <>{active && <div className="exam-lock-banner" role="status"><strong>考试模式</strong><span>{blocked ? '请先交卷，完成后即可使用其他功能。' : '计时持续进行，提前交卷或到时自动交卷后可离开。'}</span>{error && <button type="button" onClick={() => void sync()}>重试状态同步</button>}</div>}{children}</>;
}
