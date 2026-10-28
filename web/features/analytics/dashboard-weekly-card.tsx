import {useEffect} from 'react';
import {ArrowRight,BarChart3} from 'lucide-react';
import type {WeeklyReport} from '../../../shared/models/analytics';
import {qs,useResource} from '../../shared/lib/api';
import {ErrorNotice,Loading,useApp} from '../../shared/ui/components';
import {analyticsDateKey,analyticsMeasuredDuration,analyticsPercent} from './report-export';
import {analyticsMonday} from './range-navigation';
import './analytics.css';
export function DashboardWeeklyCard(){const{bootstrap}=useApp(),timeZone=bootstrap.settings?.dailyPush.timeZone||'Asia/Shanghai';const today=analyticsDateKey(new Date(),timeZone);const resource=useResource<WeeklyReport>('/api/analytics/weekly?'+qs({week:analyticsMonday(today),timeZone}));
 useEffect(()=>{const refresh=()=>{if(document.visibilityState==='visible')resource.refresh();};const timer=setInterval(refresh,60000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);};},[resource.refresh]);const data=resource.data,summary=data?.current.summary;
 return <section className="card dashboard-weekly-card" aria-label="本周学习统计"><div className="card-heading"><h2><BarChart3 size={18}/>本周学习统计</h2><a className="button" href="#/analytics">查看学习统计<ArrowRight size={14}/></a></div>{resource.error?<ErrorNotice message={resource.error} retry={resource.refresh}/>:summary&&data?<><p className="muted">{data.weekStart} — {data.weekEnd} · {timeZone}</p><dl className="dashboard-weekly-metrics"><div><dt>实际作答</dt><dd data-week-metric="answers">{summary.answers}<small>次</small></dd></div><div><dt>严格正确率</dt><dd data-week-metric="accuracy">{analyticsPercent(summary.accuracy)}</dd></div><div><dt>已知作答计时</dt><dd data-week-metric="duration">{analyticsMeasuredDuration(summary)}</dd></div><div><dt>活跃天数</dt><dd data-week-metric="activeDays">{summary.activeDays}<small>天</small></dd></div></dl><p className="muted">{summary.sessions}次提交 · {summary.reviewEvents}次复习记录{summary.missingTimeSessions?' · 部分历史计时未记录':''}</p></>:<Loading text="正在汇总本周学习…"/>}</section>;
}
