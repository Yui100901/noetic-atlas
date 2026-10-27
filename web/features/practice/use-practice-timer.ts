import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attempt } from '../../../shared/models/types';
import { ApiError, idPath, request } from '../../shared/lib/api';

interface Session {
  id: string; started: number | null; milliseconds: number; closed: boolean;
  confirmedTotal: number; confirmedSession: number;
  pausePromise?: Promise<void>; pauseConfirmed?: boolean;
}
interface PendingPause { sessionId: string; elapsedMilliseconds: number }
const milliseconds = (session: Session) => session.milliseconds + (session.started === null ? 0 : Math.max(0, performance.now() - session.started));
const total = (attempt: Attempt | null) => attempt?.practiceTiming?.elapsedMilliseconds ?? (attempt?.elapsedSeconds || 0) * 1000;
const visible = () => document.visibilityState !== 'hidden';

/** Ordinary practice is a foreground stopwatch. The database stores only
 * confirmed cumulative milliseconds; sleeping or abandoned pages cannot make
 * drafts grow. Session totals make duplicate checkpoints and late exits safe. */
export function usePracticeTimer(id: string, attempt: Attempt | null, enabled: boolean) {
  const source = useRef(attempt); source.current = attempt;
  const active = useRef(enabled); active.current = enabled;
  const mounted = useRef(true), foreground = useRef(false);
  const session = useRef<Session | null>(null), savedTotal = useRef(0), knownSessionId = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [revision, redraw] = useState(0), [error, setError] = useState('');
  const pendingKey = `noetic-atlas:practice-timing:${id}`;
  const render = () => { if (mounted.current) redraw(value => value + 1); };
  const readPause = (): PendingPause | undefined => {
    try {
      const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
      if (value && typeof value.sessionId === 'string' && /^[\p{L}\p{N}_.:-]{1,160}$/u.test(value.sessionId) && Number.isSafeInteger(value.elapsedMilliseconds) && value.elapsedMilliseconds >= 0) return value;
    } catch { /* A disabled storage area must not prevent normal practice. */ }
    return undefined;
  };
  const storePause = (value: PendingPause) => { try { sessionStorage.setItem(pendingKey, JSON.stringify(value)); } catch { /* The regular checkpoint remains durable. */ } };
  const clearPause = (value: PendingPause) => { try { const current = readPause(); if (current?.sessionId === value.sessionId && current.elapsedMilliseconds <= value.elapsedMilliseconds) sessionStorage.removeItem(pendingKey); } catch { /* Storage is optional. */ } };
  const enqueue = useCallback(<T,>(operation: () => Promise<T>) => {
    const promise = queue.current.then(operation); queue.current = promise.catch(() => undefined); return promise;
  }, []);
  const post = useCallback((body: { action: 'resume' | 'checkpoint' | 'pause'; sessionId: string; elapsedMilliseconds?: number; expectedSessionId?: string | null }, lifecycle = false) =>
    request<Attempt>(`/api/attempts/${idPath(id)}/timing`, { method: 'POST', body: JSON.stringify(body), ...(lifecycle ? { keepalive: true } : {}) }), [id]);
  const report = (reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : '计时尚未保存，请重试'); };
  const accept = (value: Attempt, current?: Session) => {
    const confirmed = total(value); savedTotal.current = confirmed; knownSessionId.current = value.practiceTiming?.sessionId || null;
    if (current && session.current === current && value.practiceTiming?.sessionId === current.id) {
      current.confirmedTotal = confirmed; current.confirmedSession = value.practiceTiming.sessionElapsedMilliseconds;
    } else if (current && session.current === current) {
      // Another reading session took ownership. Never silently reclaim its
      // timer, and never add this tab's concurrent time a second time.
      current.started = null; session.current = null; foreground.current = false;
      if (mounted.current && value.status === 'in_progress') setError('这份草稿已在其他页面继续作答；本页计时已暂停，可重新继续计时。');
    }
    render();
  };
  const resume = useCallback(async () => {
    if (!active.current || !mounted.current || !visible()) return;
    foreground.current = true;
    if (session.current && !session.current.closed) return;
    const next: Session = { id: crypto.randomUUID(), started: null, milliseconds: 0, closed: false, confirmedTotal: Math.max(savedTotal.current, total(source.current)), confirmedSession: 0 };
    session.current = next;
    try {
      await enqueue(async () => {
        const pending = readPause();
        if (pending) { const value = await post({ action: 'pause', ...pending }); accept(value); clearPause(pending); }
        if (!active.current || !mounted.current || !foreground.current || session.current !== next) return;
        let value: Attempt;
        try { value = await post({ action: 'resume', sessionId: next.id, expectedSessionId: knownSessionId.current }); }
        catch (reason) {
          if (!(reason instanceof ApiError) || reason.code !== 'PRACTICE_TIMING_SESSION_CHANGED' || !active.current || !mounted.current || !foreground.current || session.current !== next || next.closed || !visible()) throw reason;
          const current = await request<Attempt>(`/api/attempts/${idPath(id)}`); accept(current);
          if (!active.current || !mounted.current || !foreground.current || session.current !== next || next.closed || !visible()) return;
          value = await post({ action: 'resume', sessionId: next.id, expectedSessionId: knownSessionId.current });
        }
        // An exit while the request was pending queues an idempotent pause.
        // It must never revive this stopwatch after the component has left.
        if (session.current !== next || !active.current || !mounted.current || !foreground.current || next.closed) return;
        accept(value, next);
        if (session.current === next && value.status === 'in_progress') { next.started = performance.now(); if (mounted.current) setError(''); render(); }
      });
    } catch (reason) { if (session.current === next) session.current = null; report(reason); throw reason; }
  }, [enqueue, post, pendingKey]);
  const checkpoint = useCallback(async (lifecycle = false) => {
    const current = session.current;
    if (!active.current || !current || current.started === null) return;
    const elapsedMilliseconds = Math.floor(milliseconds(current));
    try {
      await enqueue(async () => { const value = await post({ action: 'checkpoint', sessionId: current.id, elapsedMilliseconds }, lifecycle); accept(value, current); if (mounted.current && session.current === current) setError(''); });
    } catch (reason) { report(reason); throw reason; }
  }, [enqueue, post]);
  const pause = useCallback(async (lifecycle = false) => {
    foreground.current = false;
    const current = session.current;
    if (!current) return;
    if (current.pauseConfirmed) return;
    if (current.pausePromise) return current.pausePromise;
    if (current.started !== null) { current.milliseconds = milliseconds(current); current.started = null; }
    current.closed = true;
    const pending = { sessionId: current.id, elapsedMilliseconds: Math.floor(current.milliseconds) };
    storePause(pending); render();
    const promise = enqueue(async () => { const value = await post({ action: 'pause', ...pending }, lifecycle); accept(value, current); current.pauseConfirmed = true; clearPause(pending); if (mounted.current && session.current === current) setError(''); }).catch(reason => { report(reason); throw reason; });
    current.pausePromise = promise;
    try { await promise; } finally { if (current.pausePromise === promise) current.pausePromise = undefined; }
  }, [enqueue, post, pendingKey]);
  const retry = useCallback(async () => { if (session.current?.started != null) await checkpoint(); else await resume(); }, [checkpoint, resume]);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;
    savedTotal.current = total(source.current); knownSessionId.current = source.current?.practiceTiming?.sessionId || null;
    let disposed = false, pageHidden = false;
    const start = () => { if (!disposed && !pageHidden && document.visibilityState !== 'hidden') void resume().catch(() => undefined); };
    const stop = () => { void pause(true).catch(() => undefined); };
    const visibility = () => { if (document.visibilityState === 'hidden') stop(); else start(); };
    const hide = () => { pageHidden = true; stop(); };
    const show = () => { pageHidden = false; start(); };
    const route = () => { pageHidden = true; stop(); };
    const beforeUnload = () => {
      stop();
      // A cancelled native close confirmation leaves this very document alive.
      // Restore its timer after the modal returns; an actual pagehide wins.
      setTimeout(start, 0);
    };
    const heartbeat = setInterval(() => { if (foreground.current) void checkpoint().catch(() => undefined); }, 30_000);
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    window.addEventListener('hashchange', route); window.addEventListener('beforeunload', beforeUnload);
    void Promise.resolve().then(start);
    return () => {
      disposed = true; mounted.current = false; clearInterval(heartbeat); stop();
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show);
      window.removeEventListener('hashchange', route); window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [id, enabled, resume, pause, checkpoint]);
  const current = session.current;
  const elapsedMilliseconds = current ? current.confirmedTotal + Math.max(0, milliseconds(current) - current.confirmedSession) : Math.max(savedTotal.current, total(attempt));
  void revision;
  return { elapsedSeconds: Math.floor(elapsedMilliseconds / 1000), running: current?.started != null, error, pause, checkpoint, resume, retry };
}
