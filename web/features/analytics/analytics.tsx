import { useState } from 'react';
import { Activity, ArrowRight, BarChart3, CalendarDays, ChartNoAxesCombined, CheckCheck, ChevronLeft, ChevronRight, Clock3, Download, Info, RefreshCw, Target } from 'lucide-react';
import type { AdaptiveAnalytics, AnalyticsBreakdown, AnalyticsMetrics, AnalyticsReport, WeeklyReport } from '../../../shared/models/analytics';
import { qs, useResource } from '../../shared/lib/api';
import { Empty, ErrorNotice, Field, Loading, PageHeader, Pagination, useApp } from '../../shared/ui/components';
import { analyticsDateKey, analyticsDuration, analyticsMeasuredDuration, analyticsNumber, analyticsPercent, downloadWeeklyReport } from './report-export';
import './analytics.css';

type AnalyticsTab = 'analysis' | 'weekly';
const localDay = (timeZone: string) => analyticsDateKey(new Date(), timeZone);
function shiftDay(day: string, offset: number): string { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); }
function monday(day: string): string { const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); return shiftDay(day, -(weekday === 0 ? 6 : weekday - 1)); }
function validDay(day: string): boolean { const value = new Date(`${day}T12:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === day; }
const signed = (value: number) => `${value > 0 ? '+' : ''}${analyticsNumber(value)}`;
const displayTime = (value: string, timeZone: string) => new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

function OverviewMetrics({ summary, comparison }: { summary: AnalyticsMetrics; comparison?: WeeklyReport['comparison'] }) {
  return <section className="analytics-metrics" aria-label="学习概览指标">
    <article className="card analytics-metric"><div className="analytics-metric-label"><span>实际作答</span><CheckCheck size={18} /></div><strong>{analyticsNumber(summary.answers)}<small>次</small></strong><p>{summary.sessions} 次提交 · {summary.answeredSessions} 次有实际回答</p>{comparison && <p className="analytics-change">较{comparison.label} {signed(comparison.deltas.answers)} 次</p>}</article>
    <article className="card analytics-metric"><div className="analytics-metric-label"><span>去重作答项</span><Target size={18} /></div><strong>{analyticsNumber(summary.uniqueItems)}<small>项</small></strong><p>覆盖 {summary.uniqueQuestions} 道原题 · 小题独立计数</p>{comparison && <p className="analytics-change">{comparison.label} {comparison.summary.uniqueItems} 项</p>}</article>
    <article className="card analytics-metric"><div className="analytics-metric-label"><span>严格正确率</span><ChartNoAxesCombined size={18} /></div><strong>{analyticsPercent(summary.accuracy)}</strong><p>{summary.graded} 次已判 · {summary.ungraded} 次待判</p>{comparison && <p className="analytics-change">{comparison.deltas.accuracyPoints == null ? '对比期缺少可比较的已判作答' : `较${comparison.label} ${signed(comparison.deltas.accuracyPoints)} 个百分点`}</p>}</article>
    <article className="card analytics-metric"><div className="analytics-metric-label"><span>已知作答计时</span><Clock3 size={18} /></div><strong>{analyticsMeasuredDuration(summary)}</strong><p>{summary.timedSessions} 次有计时{summary.missingTimeSessions ? ` · ${summary.missingTimeSessions} 次缺记录` : ' · 按提交日期归属'}</p>{comparison && <p className="analytics-change">{summary.missingTimeSessions || comparison.summary.missingTimeSessions ? '计时记录不全，暂不比较时长变化' : `较${comparison.label} ${comparison.deltas.elapsedSeconds >= 0 ? '+' : '-'}${analyticsDuration(Math.abs(comparison.deltas.elapsedSeconds))}`}</p>}</article>
  </section>;
}

function DailyTrend({ report, today }: { report: AnalyticsReport; today: string }) {
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(20);
  const grouped = report.daily.length > 31;
  const points = grouped ? Array.from({ length: Math.ceil(report.daily.length / 7) }, (_, index) => {
    const rows = report.daily.slice(index * 7, index * 7 + 7);
    return { date: rows[0]!.date, end: rows[rows.length - 1]!.date, answers: rows.reduce((sum, item) => sum + item.metrics.answers, 0) };
  }) : report.daily.map(item => ({ date: item.date, end: item.date, answers: item.metrics.answers }));
  const maximum = Math.max(1, ...points.map(item => item.answers));
  const rows = report.daily.slice((page - 1) * pageSize, page * pageSize);
  return <section className="card analytics-section" aria-label="每日学习趋势"><div className="analytics-section-heading"><div><h2>每天的积累</h2><p>实际作答次数{grouped ? ' · 图中每7天合并，明细保留每日数据' : ' · 按提交日期记录'}，空白日显示为0。</p></div><span className="badge">{report.summary.activeDays} 天活跃</span></div>
    <div className={`analytics-chart ${points.length > 14 ? 'is-dense' : ''}`} role="img" aria-label={`${report.range.from}至${report.range.to}实际作答次数趋势，下方可展开每日数据表。`}>{points.map((item, index) => <div key={item.date} className={`analytics-chart-column ${item.date === today ? 'is-today' : ''} ${item.date > today ? 'is-future' : ''}`} title={`${item.date}${item.end !== item.date ? `至${item.end}` : ''}：${item.date > today ? '未到日期' : `${item.answers}次作答`}`}><span>{item.date > today ? '—' : item.answers || ''}</span><div className="analytics-chart-track"><i style={{ height: `${item.answers / maximum * 100}%` }} /></div><small>{points.length <= 14 || index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 7) === 0 ? item.date.slice(5) : '\u00a0'}</small></div>)}</div>
    <div className="analytics-chart-caption"><span>峰值 {maximum === 1 && !points.some(item => item.answers) ? 0 : maximum} 次{grouped ? '／时段' : '／天'}</span><span>{points.some(item => item.date > today) ? '未到日期显示“—”' : '草稿与漏答不计入'}</span></div>
    <details className="analytics-table-details"><summary>查看每日数据明细</summary><div className="analytics-table-scroll"><table className="analytics-table"><caption className="sr-only">每日学习数据</caption><thead><tr><th>日期</th><th>作答</th><th>去重项</th><th>正确率</th><th>待判</th><th>复习</th><th>已知计时</th></tr></thead><tbody>{rows.map(({ date, metrics }) => <tr key={date}><td>{date}{date > today ? '（未到日期）' : ''}</td><td>{date > today ? '—' : metrics.answers}</td><td>{date > today ? '—' : metrics.uniqueItems}</td><td>{date > today ? '—' : analyticsPercent(metrics.accuracy)}</td><td>{date > today ? '—' : metrics.ungraded}</td><td>{date > today ? '—' : metrics.reviewEvents}</td><td>{date > today ? '—' : analyticsMeasuredDuration(metrics)}</td></tr>)}</tbody></table></div>{report.daily.length > 10 && <Pagination page={page} pageSize={pageSize} total={report.daily.length} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label="每日数据" />}</details>
  </section>;
}

function ResultDistribution({ summary }: { summary: AnalyticsMetrics }) {
  const states = [{ key: 'correct', label: '完全正确', count: summary.correct }, { key: 'partial', label: '部分正确', count: summary.partial }, { key: 'incorrect', label: '回答错误', count: summary.incorrect }, { key: 'ungraded', label: '未判定', count: summary.ungraded }];
  return <section className="card analytics-section" aria-label="作答判定分布"><div className="analytics-section-heading"><div><h2>作答后的反馈</h2><p>完全正确才计入正确率分子，未判题单独保留。</p></div></div><div className="analytics-result-bar" role="img" aria-label={states.map(item => `${item.label}${item.count}次`).join('，')}>{states.map(item => <i key={item.key} className={`analytics-state-${item.key}`} style={{ width: `${summary.answers ? item.count / summary.answers * 100 : 0}%` }} />)}</div><div className="analytics-result-list">{states.map(item => <div key={item.key}><i className={`analytics-state-${item.key}`} /><span>{item.label}</span><strong>{item.count}</strong></div>)}</div><div className="analytics-activity-summary"><span>漏答 <strong>{summary.omitted}</strong> 项</span><span>旧数据未知 <strong>{summary.unknown}</strong> 项</span><span>题集 <strong>{summary.paperSessions}</strong> 次</span><span>随机／单题 <strong>{summary.quickSessions}</strong> 次</span></div><p className="analytics-help" style={{ marginTop: 14 }}>漏答、未知与未判均不进入正确率分母。正确率无已判样本时显示“—”。</p></section>;
}

function AdaptiveReviewMetrics({ adaptive, comparison }: { adaptive: AdaptiveAnalytics; comparison?: WeeklyReport['comparison'] }) {
  const previous = comparison?.adaptive;
  const ratings = [
    { key: 'again', label: '重学 Again', color: 'incorrect' }, { key: 'hard', label: '困难 Hard', color: 'partial' },
    { key: 'good', label: '良好 Good', color: 'correct' }, { key: 'easy', label: '轻松 Easy', color: 'easy' },
  ] as const;
  const timing = [{ key: 'new', label: '首次反馈' }, { key: 'due', label: '已到期' }, { key: 'early', label: '提前复习' }, { key: 'overdue', label: '逾期复习' }, { key: 'unknown', label: '计划未知' }] as const;
  return <section className="analytics-adaptive" aria-label="FSRS 自适应复习统计">
    <div className="analytics-section-heading"><div><h2>复习如何转化为记忆</h2><p>FSRS 反馈按原始发生时刻归属；再次判分或修改反馈会更正原记录。</p></div><span className="badge">FSRS-6</span></div>
    <div className="analytics-metrics">
      <article className="card analytics-metric"><div className="analytics-metric-label"><span>FSRS 反馈</span><RefreshCw size={18} /></div><strong>{analyticsNumber(adaptive.feedbackEvents)}<small>次</small></strong><p>覆盖 {adaptive.uniqueCards} 张去重卡 · 方向与小题独立</p>{previous && <p className="analytics-change">{comparison.label} {previous.feedbackEvents} 次 · {previous.uniqueCards} 张卡</p>}</article>
      <article className="card analytics-metric"><div className="analytics-metric-label"><span>回忆成功率</span><Target size={18} /></div><strong>{analyticsPercent(adaptive.recallSuccessRate)}</strong><p>Hard／Good／Easy {adaptive.recallSuccesses} 次成功</p>{previous && <p className="analytics-change">{comparison.label} {analyticsPercent(previous.recallSuccessRate)}</p>}</article>
      <article className="card analytics-metric"><div className="analytics-metric-label"><span>本时段到期处理比例</span><CheckCheck size={18} /></div><strong>{analyticsPercent(adaptive.dueProcessing.rate)}</strong><p>{adaptive.queue ? `完成 ${adaptive.dueProcessing.completedDueCycles} 个到期周期 · 仍待处理 ${adaptive.queue.due} 项` : '缺少截止时刻的可靠队列快照，暂不计算'}</p></article>
      <article className="card analytics-metric"><div className="analytics-metric-label"><span>当前队列积压</span><Clock3 size={18} /></div><strong>{adaptive.queue ? analyticsNumber(adaptive.queue.due) : '—'}<small>{adaptive.queue ? '项' : ''}</small></strong><p>{adaptive.queue ? `逾期 ${adaptive.queue.overdue} · 短期重学 ${adaptive.queue.relearning} · 暂停 ${adaptive.queue.suspended}` : '统计截止时刻无可靠队列快照'}</p>{adaptive.queue && <a className="analytics-queue-link" href="#/questions?due=true">查看到期任务<ArrowRight size={12} /></a>}</article>
    </div>
    <div className="analytics-layout equal">
      <article className="card analytics-section"><div className="analytics-section-heading"><div><h2>四档记忆反馈</h2><p>Again 表示未能回忆，其他三档计回忆成功；与答题严格正确率分别统计。</p></div></div><div className="analytics-result-bar" role="img" aria-label={ratings.map(item => `${item.label}${adaptive.ratings[item.key]}次`).join('，')}>{ratings.map(item => <i key={item.key} className={`analytics-state-${item.color}`} style={{ width: `${adaptive.feedbackEvents ? adaptive.ratings[item.key] / adaptive.feedbackEvents * 100 : 0}%` }} />)}</div><div className="analytics-result-list">{ratings.map(item => <div key={item.key}><i className={`analytics-state-${item.color}`} /><span>{item.label}</span><strong>{adaptive.ratings[item.key]}</strong></div>)}</div><p className="analytics-help" style={{ marginTop: 18 }}>首次接触也可产生反馈；同一张卡的重复复习会分别计次。无反馈样本时，回忆成功率显示“—”。</p></article>
      <article className="card analytics-section"><div className="analytics-section-heading"><div><h2>复习时机与回忆表现</h2><p>以事件前的 FSRS 记忆计划判定；到期后跨统计时区的日期计逾期。</p></div></div><div className="analytics-table-scroll"><table className="analytics-table"><caption className="sr-only">各复习时机的反馈和回忆成功率</caption><thead><tr><th>时机</th><th>反馈次数</th><th>回忆成功</th><th>成功率</th></tr></thead><tbody>{timing.filter(item => item.key !== 'unknown' || adaptive.timing.unknown.feedbackEvents).map(item => <tr key={item.key}><td>{item.label}</td><td>{adaptive.timing[item.key].feedbackEvents}</td><td>{adaptive.timing[item.key].recallSuccesses}</td><td>{analyticsPercent(adaptive.timing[item.key].recallSuccessRate)}</td></tr>)}</tbody></table></div><p className="analytics-help" style={{ marginTop: 14 }}>首次反馈尚无 FSRS 复习周期。历史手工改期或旧固定计划未保留在事件记忆中，不据此推断准时率。</p></article>
    </div>
    <p className="analytics-help analytics-adaptive-method">{adaptive.dueProcessing.reason}{adaptive.queue ? '短期重学为当前已到期的学习／重学状态任务，可能同时属于逾期。' : ''}</p>
  </section>;
}

function Breakdown({ title, items, domain = false }: { title: string; items: AnalyticsBreakdown[]; domain?: boolean }) {
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(10);
  const maximum = Math.max(1, ...items.map(item => item.answers));
  return <section className="card analytics-section" aria-label={title}><div className="analytics-section-heading"><div><h2>{title}</h2><p>{domain ? '题目可以归属多个领域，领域作答数不能相加。' : '按实际作答题型统计，组合题按小题展开。'}</p></div></div>{!items.length ? <p className="analytics-empty">这段时间还没有可分析的作答。</p> : <div className="analytics-breakdown">{items.slice((page - 1) * pageSize, page * pageSize).map(item => <div className="analytics-breakdown-row" key={item.id}><div className="analytics-breakdown-title"><strong>{item.label}</strong><span>{item.answers} 次 · {item.uniqueItems} 项</span></div><div className="analytics-breakdown-track"><i style={{ width: `${item.answers / maximum * 100}%` }} /></div><p>严格正确率 {analyticsPercent(item.accuracy)} · {item.graded} 次已判{item.ungraded ? ` · ${item.ungraded} 次待判` : ''}</p></div>)}</div>}{items.length > 10 && <Pagination page={page} pageSize={pageSize} total={items.length} onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1); }} label={title} />}</section>;
}

function AnalysisBody({ report, today, comparison }: { report: AnalyticsReport; today: string; comparison?: WeeklyReport['comparison'] }) {
  return <>
    {!!report.quality.warnings.length && <div className="analytics-notice" role="note"><Info size={17} /><p>{report.quality.warnings.join(' ')}</p></div>}
    <OverviewMetrics summary={report.summary} comparison={comparison} />
    {!report.summary.sessions && !report.summary.reviewEvents && !report.adaptive?.feedbackEvents && <div className="card" style={{ marginBottom: 18 }}><Empty title="这段时间还没有学习记录" description="完成一次练习或记录一次复习后，这里会逐步形成你的学习画像。" actions={<a className="button primary" href="#/papers">去题集练习<ArrowRight size={16} /></a>} /></div>}
    {report.adaptive && <AdaptiveReviewMetrics adaptive={report.adaptive} comparison={comparison} />}
    <div className="analytics-layout"><DailyTrend key={`${report.range.from}:${report.range.to}`} report={report} today={today} /><ResultDistribution summary={report.summary} /></div>
    <div className="analytics-layout equal"><Breakdown key={`domain:${report.range.from}:${report.range.to}`} title="领域分布" items={report.domains} domain /><Breakdown key={`types:${report.range.from}:${report.range.to}`} title="题型分布" items={report.types} /></div>
    <section className="card analytics-section analytics-insights" aria-label="学习建议"><div className="analytics-section-heading"><div><h2>下一步，练得更有方向</h2><p>根据当前保留记录生成的规则建议，可随学习和判分更新。</p></div></div><div className="analytics-insight-list">{report.recommendations.map(item => <article className="analytics-insight" key={item.id}><h3><Target size={14} />{item.title}</h3><p>{item.description}</p>{item.href?.startsWith('#/') && <a className="button feature-entry" href={item.href} aria-label={`${item.title}：开始行动`}>开始行动<ArrowRight size={13} /></a>}</article>)}</div>{!report.recommendations.length && <p className="analytics-help">积累更多实际作答后，会在这里提供巩固建议。</p>}</section>
    <details className="card analytics-methods" aria-label="统计口径说明"><summary>统计口径与数据完整性</summary><ul><li>仅统计已提交的实际非空回答，草稿和漏答不计作答次数。组合题按小题统计。</li><li>重复练习计入作答次数，去重作答项按原题与小题身份去重；同一道题跨题集作答也只计一个去重项。</li><li>严格正确率＝完全正确÷（完全正确＋部分正确＋错误）；未判、漏答与未知项不进入分母。</li><li>活跃天数包含实际答题或复习记录的日期；作答计时归于提交日期，可能包含停留时间，不等同专注学习时长。缺少的历史计时不补零。</li><li>领域分布可能存在多重归属，不能直接相加；题型或领域缺失的旧记录单独说明。</li><li>周报依据当前保留记录实时生成，后续判分会更新历史周报。清理历史卷面仍可保留学习摘要；主动重置学习进度会影响统计。</li>{report.quality.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
  </>;
}

export function AnalyticsPage({ initialTab = 'analysis' }: { initialTab?: string }) {
  const { bootstrap, toast } = useApp();
  const timeZone = bootstrap.settings?.dailyPush.timeZone || 'Asia/Shanghai', today = localDay(timeZone), currentWeek = monday(today);
  const [tab, setTab] = useState<AnalyticsTab>(initialTab === 'weekly' ? 'weekly' : 'analysis');
  const [preset, setPreset] = useState('30');
  const [range, setRange] = useState({ from: shiftDay(today, -29), to: today });
  const [draftFrom, setDraftFrom] = useState(range.from), [draftTo, setDraftTo] = useState(range.to), [rangeError, setRangeError] = useState('');
  const [week, setWeek] = useState(currentWeek), [exporting, setExporting] = useState(false);
  const analytics = useResource<AnalyticsReport>(tab === 'analysis' ? `/api/analytics?${qs({ ...range, timeZone })}` : null);
  const weekly = useResource<WeeklyReport>(tab === 'weekly' ? `/api/analytics/weekly?${qs({ week, timeZone })}` : null);
  const active = tab === 'weekly' ? weekly : analytics;
  const changeTab = (next: AnalyticsTab) => { setTab(next); window.location.hash = `#/analytics${next === 'weekly' ? '?tab=weekly' : ''}`; };
  const changePreset = (value: string) => {
    setPreset(value); setRangeError('');
    if (value !== 'custom') { const next = { from: shiftDay(today, 1 - Number(value)), to: today }; setRange(next); setDraftFrom(next.from); setDraftTo(next.to); }
  };
  const applyRange = () => {
    if (!validDay(draftFrom) || !validDay(draftTo) || draftFrom > draftTo) { setRangeError('请选择有效日期，开始日期不能晚于结束日期。'); return; }
    const days = (Date.parse(`${draftTo}T00:00:00Z`) - Date.parse(`${draftFrom}T00:00:00Z`)) / 86400000 + 1;
    if (days > 366) { setRangeError('一次最多查看366天，请缩小日期范围。'); return; }
    if (draftTo > today) { setRangeError('结束日期不能晚于今天。'); return; }
    setRangeError(''); setRange({ from: draftFrom, to: draftTo });
  };
  const exportReport = async () => { if (!weekly.data || weekly.loading) return; setExporting(true); try { await downloadWeeklyReport(weekly.data); toast('学习周报已导出'); } catch (reason) { toast((reason as Error).message || '周报导出失败', true); } finally { setExporting(false); } };
  return <div className="analytics-page"><PageHeader eyebrow="LEARNING ANALYTICS" title="看见积累，找到下一步。" description="把作答、复习与反馈连起来，观察自己的学习节奏。" actions={<><button className="button" onClick={active.refresh} disabled={active.loading}><RefreshCw size={16} />刷新统计</button>{tab === 'weekly' && <button className="button primary" onClick={() => { void exportReport(); }} disabled={exporting || weekly.loading || !weekly.data}><Download size={16} />{exporting ? '正在导出…' : '导出周报 Markdown'}</button>}</>} />
    <div className="analytics-tabs" role="tablist" aria-label="学习统计视图"><button role="tab" id="analytics-tab-analysis" aria-controls="analytics-panel" aria-selected={tab === 'analysis'} onClick={() => changeTab('analysis')}><BarChart3 size={17} />统计分析</button><button role="tab" id="analytics-tab-weekly" aria-controls="analytics-panel" aria-selected={tab === 'weekly'} onClick={() => changeTab('weekly')}><CalendarDays size={17} />学习周报</button></div>
    <div role="tabpanel" id="analytics-panel" aria-labelledby={`analytics-tab-${tab}`}>
      {tab === 'analysis' ? <form className="card analytics-controls" onSubmit={event => { event.preventDefault(); applyRange(); }}><Field label="统计范围"><select value={preset} onChange={event => changePreset(event.target.value)}><option value="7">近7天</option><option value="30">近30天</option><option value="90">近90天</option><option value="custom">自定义</option></select></Field>{preset === 'custom' && <><Field label="开始日期"><input type="date" required max={draftTo || today} value={draftFrom} onChange={event => setDraftFrom(event.target.value)} /></Field><Field label="结束日期"><input type="date" required min={draftFrom || undefined} max={today} value={draftTo} onChange={event => setDraftTo(event.target.value)} /></Field><button className="button primary" type="submit">应用日期范围</button></>}<p className="analytics-controls-note">按 {timeZone} 的日期统计。默认近30天，包含今天。</p></form> : <div className="card analytics-controls"><Field label="周报所在日期" className="analytics-week-picker"><input type="date" max={today} value={week} onChange={event => { if (validDay(event.target.value) && event.target.value <= today) setWeek(monday(event.target.value)); }} /></Field><div className="analytics-week-navigation"><button className="icon-button" aria-label="上一周" title="上一周" onClick={() => setWeek(shiftDay(week, -7))}><ChevronLeft size={18} /></button><button className="button" onClick={() => setWeek(currentWeek)}>本周</button><button className="icon-button" aria-label="下一周" title="下一周" disabled={week >= currentWeek} onClick={() => setWeek(shiftDay(week, 7))}><ChevronRight size={18} /></button></div><p className="analytics-controls-note">每周一至周日 · {timeZone}<br />本周进行中时，与上周相同已过时段比较。</p></div>}
      {rangeError && tab === 'analysis' && <ErrorNotice message={rangeError} />}
      {active.loading ? <Loading text="正在汇总学习统计…" /> : active.error ? <ErrorNotice message={active.error} retry={active.refresh} /> : tab === 'weekly' && weekly.data ? <>
        <div className="analytics-range-label"><h2>{weekly.data.weekStart} — {weekly.data.weekEnd} 学习周报</h2><span>{weekly.data.isCurrentWeek ? '本周进行中' : '完整自然周'} · 截至 {displayTime(weekly.data.generatedAt, timeZone)}</span></div>
        <section className="card analytics-section analytics-week-summary" aria-label="周报摘要"><h2>这一周的足迹</h2><p>已提交 {weekly.data.current.summary.sessions} 次练习，实际回答 {weekly.data.current.summary.answers} 次，覆盖 {weekly.data.current.summary.uniqueItems} 个独立作答项；共有 {weekly.data.current.summary.activeDays} 天实际答题或复习。{weekly.data.current.summary.graded ? `已判作答的严格正确率为${analyticsPercent(weekly.data.current.summary.accuracy)}。` : '目前还没有可计算正确率的已判作答。'}{weekly.data.current.summary.ungraded ? `另有${weekly.data.current.summary.ungraded}次作答待判。` : ''}</p><div className="analytics-activity-summary"><span><Activity size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />复习记录 <strong>{weekly.data.current.summary.reviewEvents}</strong> 次</span><span>对比：<strong>{weekly.data.comparison.label}</strong>（{weekly.data.comparison.from} — {weekly.data.comparison.to}）</span></div></section>
        <AnalysisBody report={weekly.data.current} comparison={weekly.data.comparison} today={today} />
      </> : analytics.data ? <><div className="analytics-range-label"><h2>{analytics.data.range.from} — {analytics.data.range.to}</h2><span>{analytics.data.range.partial ? '包含进行中的今天' : '完整日期范围'} · 截至 {displayTime(analytics.data.range.asOf, timeZone)}</span></div><AnalysisBody report={analytics.data} today={today} /></> : null}
    </div>
  </div>;
}
