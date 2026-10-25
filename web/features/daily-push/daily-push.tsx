import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, RefreshCw, Settings2 } from 'lucide-react';
import type { DailyPushCheckResponse, DailyPushOverview, DailyPushRecord } from '../../../shared/models/daily-push';
import { href, idPath, request, send } from '../../shared/lib/api';
import { useApp } from '../../shared/ui/components';
import './daily-push.css';

interface DailyContext {
  overview: DailyPushOverview | null; loading: boolean; error: string;
  refresh: (check?: boolean) => Promise<void>; markRead: (record: DailyPushRecord) => Promise<void>;
}
const DailyPushContext = createContext<DailyContext | null>(null);
export function useDailyPush() { const context = useContext(DailyPushContext); if (!context) throw new Error('每日推题尚未就绪'); return context; }
const points = (value: number) => Number(value.toFixed(2)).toLocaleString('zh-CN');
const examActive = () => document.body.classList.contains('exam-active');

/** Only ask for a mutation when this local calendar day is due and missing.
 * The service remains authoritative and protects against duplicate requests. */
function due(overview: DailyPushOverview): boolean {
  if (!overview.config.enabled || overview.today || examActive()) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: overview.config.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const hour = parts.find(part => part.type === 'hour')?.value || '00', minute = parts.find(part => part.type === 'minute')?.value || '00';
    return `${hour}:${minute}` >= overview.config.scheduleTime;
  } catch { return false; }
}

export function DailyPushProvider({ children }: { children: ReactNode }) {
  const { bootstrap, reload } = useApp();
  const [overview, setOverview] = useState<DailyPushOverview | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const mounted = useRef(true), pending = useRef(false), queued = useRef<boolean | null>(null);
  const refresh: DailyContext['refresh'] = useCallback(async (check = true) => {
    if (examActive()) return;
    if (pending.current) { queued.current = queued.current === true || check; return; }
    pending.current = true;
    try {
      let value = await request<DailyPushOverview>('/api/daily-push');
      if (check && due(value) && !examActive()) {
        const result = await send<DailyPushCheckResponse>('/api/daily-push/check', 'POST');
        value = result.overview; if (result.generated) reload();
      }
      if (mounted.current) { setOverview(value); setError(''); }
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
    finally {
      pending.current = false;
      if (mounted.current) {
        setLoading(false);
        if (queued.current !== null) { const next = queued.current; queued.current = null; queueMicrotask(() => void refresh(next)); }
      }
    }
  }, [reload]);
  useEffect(() => {
    mounted.current = true;
    const trigger = () => { if (document.visibilityState === 'visible') void refresh(true); };
    const initial = setTimeout(trigger, 0), timer = setInterval(trigger, 30_000);
    const exam = (event: Event) => { if (!(event as CustomEvent).detail) trigger(); };
    window.addEventListener('focus', trigger); document.addEventListener('visibilitychange', trigger); window.addEventListener('noetic-atlas-exam-state', exam);
    return () => { mounted.current = false; clearTimeout(initial); clearInterval(timer); window.removeEventListener('focus', trigger); document.removeEventListener('visibilitychange', trigger); window.removeEventListener('noetic-atlas-exam-state', exam); };
  }, [refresh]);
  useEffect(() => { void refresh(true); }, [bootstrap.settings?.updatedAt, refresh]);
  const markRead = useCallback(async (record: DailyPushRecord) => {
    if (record.readAt || examActive()) return;
    await send(`/api/daily-push/${idPath(record.id)}/read`, 'POST');
    await refresh(false);
  }, [refresh]);
  return <DailyPushContext.Provider value={{ overview, loading, error, refresh, markRead }}>{children}</DailyPushContext.Provider>;
}

/** Dashboard and other learning suggestions reuse the current day's state. */
export function DailyPushQuickLink() {
  const { overview, markRead } = useDailyPush();
  const today = overview?.today;
  const ready = !!today?.paperId && today.paperAvailable;
  const disabled = !!overview && !overview.config.enabled;
  const target = ready ? href('papers', today!.paperId!) : disabled ? '#/settings?tab=daily' : '#/papers';
  const label = ready ? '开始今日推荐' : disabled ? '开启每日推荐' : '查看每日推荐';
  return <a className="button feature-entry daily-push-quick-link" href={target} onClick={() => { if (ready && today) void markRead(today).catch(() => {}); }}><CalendarDays size={16} />{label}</a>;
}

/** Daily recommendations live alongside the ordinary sets they create. */
export function DailyPushCard() {
  const { overview, loading, error, refresh, markRead } = useDailyPush();
  const [checking, setChecking] = useState(false);
  const today = overview?.today;
  const check = async () => { setChecking(true); try { await refresh(true); } finally { setChecking(false); } };
  let description = '正在检查今日推荐…';
  if (overview) description = today
    ? `复习 ${points(today.reviewPoints)} 分 · 新题 ${points(today.newPoints)} 分 · 合计 ${points(today.totalPoints)} 分${today.shortfall ? ` · 距目标还差 ${points(today.shortfall)} 分` : ''}`
    : overview.config.enabled
      ? `每天 ${overview.config.scheduleTime} 生成 · 复习 ${points(overview.config.reviewPoints)} 分，新题 ${points(overview.config.newPoints)} 分`
      : '尚未开启 · 默认每天复习30分、新题20分';
  const unavailable = today && !today.paperAvailable
    ? today.paperId ? '今日题集已归档或删除，往期推荐可在题集库查找。' : '所选范围暂无可练习题目，请调整领域或分类。'
    : null;
  return <section className={`card daily-push-card ${today && !today.readAt ? 'unread' : ''} ${today?.shortfall ? 'has-shortfall' : ''}`} role="status" aria-label="每日推荐">
    <span className="daily-push-card-icon"><CalendarDays size={21} /></span>
    <div className="daily-push-card-copy"><div><strong>每日推荐</strong>{today && <span className="daily-push-card-date">{today.dateKey}</span>}{today && !today.readAt && <span className="badge">新推送</span>}</div><p>{description}</p>{unavailable && <p className="daily-push-card-hint">{unavailable}</p>}{error && <p className="daily-push-card-error" role="alert">{error}</p>}</div>
    <div className="daily-push-card-actions">{today?.paperId && today.paperAvailable
      ? <a className="button primary" href={href('papers', today.paperId)} onClick={() => { void markRead(today).catch(() => {}); }}>打开今日题集<ArrowRight size={15} /></a>
      : overview && !overview.config.enabled && <a className="button primary" href="#/settings?tab=daily">开启每日推荐<ArrowRight size={15} /></a>}
      <button className="icon-button" type="button" disabled={checking || loading && !overview} aria-label="检查今日推荐" title="检查今日推荐" onClick={() => { void check(); }}><RefreshCw size={17} className={checking ? 'daily-push-checking' : ''} /></button>
      <a className="icon-button" href="#/settings?tab=daily" aria-label="设置每日推荐" title="设置每日推荐"><Settings2 size={17} /></a>
    </div>
  </section>;
}
