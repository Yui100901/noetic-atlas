import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Bell, BellRing, CalendarDays, Check, RefreshCw, Settings2 } from 'lucide-react';
import type { DailyPushCheckResponse, DailyPushOverview, DailyPushRecord, DailyPushView } from '../../../shared/models/daily-push';
import { href, idPath, localDate, request, send } from '../../shared/lib/api';
import { usePagination } from '../../shared/lib/pagination';
import { Empty, ErrorNotice, Loading, PageHeader, Pagination, useApp } from '../../shared/ui/components';
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

export function DailyPushTopbarLink() {
  const { overview } = useDailyPush(); const count = overview?.unreadCount || 0;
  return <a className={`daily-push-topbar-link ${count ? 'has-unread' : ''}`} href="#/daily-push" aria-label={`每日推题通知${count ? `，${count}份未读` : ''}`}><Bell size={18} /><span className="daily-push-topbar-label">每日推题</span>{count > 0 && <strong className="daily-push-unread">{count > 99 ? '99+' : count}</strong>}</a>;
}

export function DailyPushBanner() {
  const { overview, markRead } = useDailyPush();
  if (!overview || (!overview.today && !overview.unreadCount && !overview.config.enabled)) return null;
  const today = overview.today;
  return <section className={`daily-push-banner ${today?.shortfall ? 'has-shortfall' : ''}`} aria-label="每日推题提醒" role="status"><span className="daily-push-banner-icon">{today && !today.readAt ? <BellRing size={24} /> : <CalendarDays size={24} />}</span><div className="daily-push-banner-copy"><div><strong>{today ? today.paperAvailable ? '今日推题已就绪' : today.paperId ? '今日题集已归档或删除' : '今日暂无可练习题目' : overview.unreadCount ? `有 ${overview.unreadCount} 份推题尚未查看` : '每日推题已开启'}</strong>{today && !today.readAt && <span className="badge">新推送</span>}</div><p>{today ? `复习 ${points(today.reviewPoints)} 分 · 新题 ${points(today.newPoints)} 分 · 合计 ${points(today.totalPoints)} 分${today.shortfall ? ` · 距目标还差 ${points(today.shortfall)} 分` : ''}` : `每天 ${overview.config.scheduleTime} 生成，目标复习 ${points(overview.config.reviewPoints)} 分、新题 ${points(overview.config.newPoints)} 分。`}</p></div><div className="daily-push-banner-actions">{today?.paperId && today.paperAvailable && <a className="button primary" href={href('papers', today.paperId)} onClick={() => { void markRead(today).catch(() => {}); }}>打开今日题集<ArrowRight size={16} /></a>}<a className="button" href="#/daily-push">{today ? '查看推题' : '查看计划'}</a></div></section>;
}

function DailyRecordCard({ record }: { record: DailyPushView }) {
  const { markRead } = useDailyPush(), { toast } = useApp(); const [busy, setBusy] = useState(false);
  const read = async () => { setBusy(true); try { await markRead(record); } catch (reason) { toast((reason as Error).message, true); } finally { setBusy(false); } };
  return <article className={`card daily-push-record ${!record.readAt ? 'unread' : ''}`}><header><div><p className="eyebrow">{record.dateKey} · {record.readAt ? '已查看' : '未读推送'}</p><h2>{record.title}</h2></div><span className="daily-push-total">{points(record.totalPoints)}<small>分</small></span></header><div className="daily-push-score-grid"><div><span>复习</span><strong>{points(record.reviewPoints)} 分</strong><small>{record.reviewCount} 题 · 目标 {points(record.targetReviewPoints)} 分</small></div><div><span>新题</span><strong>{points(record.newPoints)} 分</strong><small>{record.newCount} 题 · 初始目标 {points(record.baseNewPoints)} 分</small></div></div>{record.reason && <p className={record.shortfall ? 'daily-push-shortfall' : 'muted'}>{record.reason}</p>}{record.shortfall > 0 && <p className="daily-push-shortfall">当前可选题量不足，距 {points(record.targetTotalPoints)} 分目标还差 {points(record.shortfall)} 分；不会重复题目凑分。</p>}{record.paperId && !record.paperAvailable && <p className="muted">原题集已归档或删除，推送摘要继续保留。</p>}<footer><small>生成于 {localDate(record.generatedAt)}</small><div className="action-row">{!record.readAt && <button className="button" disabled={busy} onClick={() => void read()}><Check size={15} />标记已读</button>}{record.paperId && record.paperAvailable ? <a className="button primary" href={href('papers', record.paperId)} onClick={() => { void read(); }}>打开题集<ArrowRight size={15} /></a> : !record.paperId && <a className="button" href="#/settings?tab=daily">调整推题范围</a>}</div></footer></article>;
}

export function DailyPushPage() {
  const { overview, loading, error, refresh } = useDailyPush(); const paging = usePagination(overview?.recent || [], 'daily-push');
  return <><PageHeader eyebrow="DAILY PRACTICE" title="每天一份，温故知新。" description="按选定领域与分类推送题集，复习不足的分值补给新题，达到目标即可。" actions={<><button className="button" onClick={() => void refresh(true)}><RefreshCw size={16} />检查今日推题</button><a className="button primary" href="#/settings?tab=daily"><Settings2 size={16} />配置每日推题</a></>} />{error && <ErrorNotice message={error} retry={() => void refresh(true)} />}{loading && !overview ? <Loading /> : overview && <><section className="card daily-push-plan"><div><strong>{overview.config.enabled ? '每日推题已开启' : '每日推题未开启'}</strong><p>{overview.config.enabled ? `每天 ${overview.config.scheduleTime}（${overview.config.timeZone}）· 初始目标 ${points(overview.config.reviewPoints + overview.config.newPoints)} 分` : '选择学习领域和分类后开启，已有每日题集仍可继续练习。'}</p></div><a className="button" href="#/settings?tab=daily">{overview.config.enabled ? '调整计划' : '开始设置'}<ArrowRight size={15} /></a></section>{!overview.today && <div className="notice info">{overview.config.enabled ? `今天的推题尚未生成，计划时间为 ${overview.config.scheduleTime}。程序运行时到点生成；重新打开后会检查当天任务。` : '开启后默认每天零点推送：复习30分、新题20分，可在系统配置中修改。'}</div>}<div className="section-heading"><div><h2>最近{overview.recentLimit}次推送</h2><p>关闭自动推题后，已经生成的题集和学习记录继续保留。</p></div></div>{paging.total ? <><div className="daily-push-record-list">{paging.items.map(record => <DailyRecordCard key={record.id} record={record} />)}</div><Pagination {...paging} label="每日推题记录" /></> : <Empty title="还没有每日推题" description="开启并设置学习范围，到计划时间会生成当天题集。" actions={<a className="button primary" href="#/settings?tab=daily">设置推题计划</a>} />}</>}</>;
}
