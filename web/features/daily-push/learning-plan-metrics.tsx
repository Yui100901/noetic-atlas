import type { LearningPlanAnalytics } from '../../../shared/models/learning-plan';
import './learning-plan.css';
export function LearningPlanMetrics({ value }: { value?: LearningPlanAnalytics }) {
  if (!value?.days) return null;
  return (
    <section className="card learning-plan-metrics">
      <h2>学习目标完成情况</h2>
      <p className="muted">
        本范围安排 {value.scheduledDays} 个学习日，另有 {value.restDays} 个休息日；已完成{' '}
        {value.completedDays} 天的全部任务；已完成 {value.completedPoints}/{value.plannedPoints}{' '}
        分，目标量 {value.targetPoints} 分。按计划日期汇总。
      </p>
      <div className="learning-plan-task-list">
        {value.goals.map((g) => (
          <div className="learning-plan-task" key={g.id}>
            <strong>{g.name}</strong>
            <span>
              {g.completed}/{g.total} 项 · {g.completedPoints}/{g.plannedPoints} 分
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
