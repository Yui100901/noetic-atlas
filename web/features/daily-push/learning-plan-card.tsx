import { useState } from 'react';
import { ArrowRight, CalendarDays, Play, Settings2 } from 'lucide-react';
import type {
  LearningDayOverview,
  LearningPlanProgress,
} from '../../../shared/models/learning-plan';
import { idPath, send } from '../../shared/lib/api';
import { ErrorNotice } from '../../shared/ui/components';
import './learning-plan.css';

export const planHref = (id: string) => `#/daily-plan/${idPath(id)}`;
export async function launchPlan(
  id: string,
  options: { goalId?: string; mode?: 'focus' | 'practice'; resume?: boolean } = {},
) {
  const result = await send<{ id: string; kind: 'focus' | 'practice' }>(
    `/api/learning-plans/${idPath(id)}/start`,
    'POST',
    options,
  );
  window.location.hash = `#/${result.kind === 'focus' ? 'focus-review' : 'attempts'}/${idPath(result.id)}`;
}
export function PlanProgress({
  value,
  label = '学习计划进度',
}: {
  value: LearningPlanProgress;
  label?: string;
}) {
  return (
    <div className="learning-plan-progress">
      <progress max={100} value={value.percent} aria-label={label} />
      <span>
        已完成 {value.completed}/{value.total} 项 · {value.completedPoints}/{value.totalPoints} 分 ·{' '}
        {value.percent}%
      </span>
    </div>
  );
}
export function LearningPlanCard({
  plan,
  onRefresh,
}: {
  plan: LearningDayOverview;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const hasDrafts = !!(plan.focusDrafts.length + plan.practiceDrafts.length);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await launchPlan(plan.id);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const read = () => {
    if (!plan.readAt)
      void send(`/api/learning-plans/${idPath(plan.id)}/read`, 'POST', {})
        .then(onRefresh)
        .catch(() => {});
  };
  return (
    <section className="card learning-plan-card" aria-label="每日学习计划">
      <div className="learning-plan-card-heading">
        <CalendarDays size={22} />
        <div>
          <strong>{plan.title}</strong>
          {!plan.readAt && <span className="badge">新安排</span>}
          <p className="muted">
            {plan.goals.length} 个目标 · 实际安排 {plan.totalPoints} 分
            {plan.shortfall > 0 ? ` · 缺少 ${plan.shortfall} 分` : ''}
          </p>
        </div>
      </div>
      <PlanProgress value={plan.progress} />
      <div className="learning-plan-goal-links">
        {plan.goals.slice(0, 4).map((g) => (
          <a
            key={g.goal.id}
            href={`${planHref(plan.id)}?goalId=${idPath(g.goal.id)}`}
            onClick={read}
          >
            <strong>{g.goal.name}</strong>
            <span>
              {plan.goalProgress[g.goal.id]?.completed || 0}/
              {plan.goalProgress[g.goal.id]?.total || 0} 项
            </span>
          </a>
        ))}
      </div>
      {!plan.goals.length && <p className="muted">今天是休息日，未安排学习目标。</p>}
      {error && <ErrorNotice message={error} />}
      <div className="learning-plan-actions">
        <button
          type="button"
          className="button primary"
          disabled={
            busy ||
            (!hasDrafts &&
              (!plan.progress.total || plan.progress.completed === plan.progress.total))
          }
          onClick={() => void start()}
        >
          <Play size={16} />
          {busy
            ? '正在准备…'
            : hasDrafts
              ? '继续未完成学习'
              : plan.progress.total && plan.progress.completed === plan.progress.total
                ? '今日已完成'
                : '继续今日学习'}
        </button>
        <a className="button" href={planHref(plan.id)} onClick={read}>
          查看计划
          <ArrowRight size={15} />
        </a>
        <a className="button" href="#/settings?tab=daily">
          <Settings2 size={15} />
          调整计划
        </a>
      </div>
    </section>
  );
}
