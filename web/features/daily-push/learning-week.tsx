import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import type { LearningWeekSummary } from '../../../shared/models/learning-time';
import { useResource } from '../../shared/lib/api';
import { ErrorNotice, Loading, useApp } from '../../shared/ui/components';
import './learning-plan.css';

const shift = (date: string, days: number) => {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
export function LearningWeekCard({ compact = false }: { compact?: boolean }) {
  const { bootstrap } = useApp();
  const [date, setDate] = useState(''),
    resource = useResource<LearningWeekSummary>(
      '/api/learning-plans/week' + (date ? '?date=' + date : ''),
    ),
    week = resource.data;
  const settingsVersion = bootstrap.settings?.updatedAt || '';
  const savedSettings = useRef(settingsVersion);
  useEffect(() => {
    if (savedSettings.current === settingsVersion) return;
    savedSettings.current = settingsVersion;
    resource.refresh();
  }, [settingsVersion, resource.refresh]);
  return (
    <section
      className={`learning-week ${compact ? 'learning-week-compact' : 'card'}`}
      aria-label="每周学习时间目标"
    >
      <div className="learning-week-heading">
        <h2>
          <Clock3 size={18} />
          每周学习时间
        </h2>
        <div className="learning-week-controls">
          <button
            type="button"
            className="icon-button"
            aria-label="上一周学习时间"
            disabled={!week}
            onClick={() => week && setDate(shift(week.from, -7))}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setDate('');
              resource.refresh();
            }}
          >
            本周
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="下一周学习时间"
            disabled={!week}
            onClick={() => week && setDate(shift(week.from, 7))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      {resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.refresh} />
      ) : !week ? (
        <Loading text="正在统计学习时间…" />
      ) : (
        <>
          <p className="muted">
            {week.from} — {week.to} · {week.timeZone}
          </p>
          <div className="learning-week-numbers">
            <strong>
              {Math.floor(week.elapsedSeconds / 60)}
              <small> 分钟已学</small>
            </strong>
            <span>
              {week.targetMinutes
                ? `目标 ${week.targetMinutes} 分钟 · 剩余 ${Math.ceil(week.remainingSeconds / 60)} 分钟`
                : '尚未设置周时间目标'}
            </span>
          </div>
          {!!week.targetMinutes && (
            <progress max={100} value={week.percent} aria-label="周时间目标进度" />
          )}
          {week.inProgressSeconds > 0 && (
            <p className="muted">
              进行中已保存 {Math.floor(week.inProgressSeconds / 60)} 分钟，完成提交后计入目标。
            </p>
          )}
          {week.missingTimeSessions > 0 && (
            <p className="muted">
              {week.missingTimeSessions} 次历史缺少可可靠归属的计时，未估填时长。
            </p>
          )}
          {!compact && (
            <details>
              <summary>计时口径与每日记录</summary>
              <p className="muted">{week.note}目标按已保存设置展示。</p>
              <div className="learning-week-days">
                {week.daily.map((day) => (
                  <div key={day.date}>
                    <span>{day.date.slice(5)}</span>
                    <strong>{Math.floor(day.elapsedSeconds / 60)} 分钟</strong>
                    <small>
                      {day.targetMinutes ? `日预算 ${day.targetMinutes} 分钟` : '无日预算'}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          )}
          {!week.targetMinutes && (
            <a className="button" href="#/settings?tab=review&sub=daily">
              设置学习时间目标
            </a>
          )}
        </>
      )}
    </section>
  );
}
