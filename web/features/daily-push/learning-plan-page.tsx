import { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, Play, RefreshCw, Settings2 } from 'lucide-react';
import type { LearningDayView } from '../../../shared/models/learning-plan';
import { idPath, send, useResource } from '../../shared/lib/api';
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageHeader,
  Pagination,
  useApp,
} from '../../shared/ui/components';
import { launchPlan, PlanProgress } from './learning-plan-card';
import { LearningPlanHistory } from './learning-plan-history';
import './learning-plan.css';
import { LearningWeekCard } from './learning-week';

export function LearningPlanPage({ id }: { id: string }) {
  const resource = useResource<LearningDayView>(`/api/learning-plans/${idPath(id)}`),
    { bootstrap } = useApp(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [goalId, setGoalId] = useState(
      () => new URLSearchParams(window.location.hash.split('?')[1]).get('goalId') || '',
    ),
    [status, setStatus] = useState('all'),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(20);
  const day = resource.data;
  useEffect(() => {
    if (day && !day.readAt)
      void send(`/api/learning-plans/${idPath(day.id)}/read`, 'POST', {}).catch(() => {});
  }, [day?.id]);
  useEffect(() => setPage(1), [goalId, status]);
  const start = async (options: { goalId?: string; mode?: 'focus' | 'practice' }) => {
    setBusy(true);
    setError('');
    try {
      await launchPlan(id, options);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (resource.loading) return <Loading />;
  if (resource.error || !day)
    return <ErrorNotice message={resource.error || '学习计划不存在'} retry={resource.refresh} />;
  const tasks = day.tasks.filter(
    (t) =>
      (!goalId || t.goalId === goalId) &&
      (status === 'all' ||
        (status === 'completed'
          ? !!day.taskProgress[t.id]?.completedAt
          : !day.taskProgress[t.id]?.completedAt)),
  );
  const visible = tasks.slice((page - 1) * pageSize, page * pageSize),
    finished =
      day.progress.total === day.progress.completed &&
      !day.focusDrafts.length &&
      !day.practiceDrafts.length;
  return (
    <article className="learning-plan-page">
      <a className="back-link" href="#/papers">
        <ArrowLeft size={15} />
        返回题集
      </a>
      <PageHeader
        eyebrow="DAILY LEARNING PLAN"
        title={day.title}
        description={`${day.timeZone} · 已安排 ${day.totalPoints} 分 · 目标 ${day.targetReviewPoints + day.targetNewPoints} 分`}
        actions={
          <>
            <button className="button" type="button" disabled={busy} onClick={resource.refresh}>
              <RefreshCw size={15} />
              刷新进度
            </button>
            <a className="button" href="#/settings?tab=review&sub=daily">
              <Settings2 size={15} />
              调整计划
            </a>
          </>
        }
      />
      {error && <ErrorNotice message={error} />}
      <LearningWeekCard />
      {day.timeBudget && (
        <section className="card">
          <h2>今日时间安排</h2>
          <p>
            预算 {Math.round(day.timeBudget.targetSeconds / 60)} 分钟，预计{' '}
            {Math.ceil(day.timeBudget.estimatedSeconds / 60)} 分钟；{day.timeBudget.measuredTasks}{' '}
            项按已计时单题样本，{day.timeBudget.defaultTasks} 项使用题型默认估时。
          </p>
          <p className="muted">
            估时不代表实际耗时。
            {day.timeBudget.limited
              ? '已按时间或容量限制控制任务量；剩余到期任务可到实时复习队列处理。'
              : '当前可用任务已全部安排。'}
          </p>
        </section>
      )}
      <section className="card">
        <PlanProgress value={day.progress} />
        <p className="muted">
          实际作答 {day.progress.answered} 项 · 已评级 {day.progress.reviewed}{' '}
          项。完成一次学习与掌握知识分别记录；跳过和浏览解析不计完成。
        </p>
        {day.shortfall > 0 && (
          <p className="notice warning">
            可用任务不足，本日比目标少 {day.shortfall} 分；未重复抽题凑数。
          </p>
        )}
        <div className="learning-plan-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || finished || !day.tasks.length}
            onClick={() => void start({})}
          >
            <Play size={16} />
            继续今日学习
          </button>
          <button
            type="button"
            className="button"
            disabled={busy || finished || !day.tasks.length}
            onClick={() => void start({ mode: 'focus' })}
          >
            <BookOpen size={16} />
            连续专注复习
          </button>
          <a className="button" href="#/learning/due">
            查看实时待复习
          </a>
        </div>
      </section>
      {!!(day.focusDrafts.length + day.practiceDrafts.length) && (
        <details className="card learning-plan-drafts">
          <summary>继续未完成学习（{day.focusDrafts.length + day.practiceDrafts.length}）</summary>
          <div className="learning-plan-actions">
            {day.focusDrafts.map((d) => (
              <a className="button" key={d.id} href={`#/focus-review/${idPath(d.id)}`}>
                专注复习 {d.rated}/{d.total} 项
              </a>
            ))}
            {day.practiceDrafts.map((d) => (
              <a className="button" key={d.id} href={`#/attempts/${idPath(d.id)}`}>
                继续普通练习
              </a>
            ))}
          </div>
        </details>
      )}
      {!day.goals.length ? (
        <Empty
          title="今天没有安排学习目标"
          description="可在计划中设置参与学习的星期和启用状态。"
        />
      ) : (
        <div className="learning-plan-goals">
          {day.goals.map((g) => {
            const p = day.goalProgress[g.goal.id]!,
              done = p.completed === p.total;
            return (
              <section className="card learning-plan-goal" key={g.goal.id}>
                <div>
                  <span className="section-label">
                    {bootstrap.domains.find((d) => d.id === g.goal.domainId)?.name ||
                      '原领域已删除'}
                  </span>
                  <h2>{g.goal.name}</h2>
                </div>
                <PlanProgress label={`${g.goal.name}进度`} value={p} />
                <p className="muted">
                  复习 {g.reviewPoints}/{g.targetReviewPoints} 分 · 新题 {g.newPoints}/
                  {g.targetNewPoints} 分
                </p>
                {g.reason && <p className="learning-plan-reason">{g.reason}</p>}
                <div className="learning-plan-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy || done || !p.total}
                    onClick={() => void start({ goalId: g.goal.id })}
                  >
                    {g.goal.mode === 'focus' ? '专注复习' : '普通练习'}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      setGoalId(g.goal.id);
                      document
                        .getElementById('daily-plan-tasks')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    查看任务
                  </button>
                  {g.paperId && day.paperAvailability[g.paperId] && (
                    <a className="button" href={`#/papers/${idPath(g.paperId)}`}>
                      来源题集
                    </a>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <section className="card learning-plan-task-section" id="daily-plan-tasks">
        <h2>任务清单</h2>
        <div className="learning-plan-grid">
          <Field label="学习目标筛选">
            <select value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              <option value="">全部目标</option>
              {day.goals.map((g) => (
                <option key={g.goal.id} value={g.goal.id}>
                  {g.goal.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="完成状态">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="all">全部任务</option>
              <option value="pending">未完成</option>
              <option value="completed">已完成</option>
            </select>
          </Field>
        </div>
        <div className="learning-plan-task-list">
          {visible.map((t) => {
            const r = day.taskProgress[t.id],
              goal = day.goals.find((g) => g.goal.id === t.goalId)!;
            return (
              <div className={`learning-plan-task ${r?.completedAt ? 'completed' : ''}`} key={t.id}>
                <div>
                  <strong>{t.title}</strong>
                  <p>
                    {goal.goal.name} · {t.kind === 'review' ? '复习' : '新题'} ·{' '}
                    {t.direction === 'meaning_to_word'
                      ? '逆向'
                      : t.direction === 'word_to_meaning'
                        ? '顺向'
                        : '通用题'}{' '}
                    · {t.points}分
                  </p>
                </div>
                <span className="badge">
                  {r?.completedAt ? '已完成' : r?.answeredAt ? '已作答，待评级' : '待学习'}
                </span>
              </div>
            );
          })}
          {!visible.length && <p className="muted">当前筛选没有任务。</p>}
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={tasks.length}
          onPage={setPage}
          onPageSize={(n) => {
            setPageSize(n);
            setPage(1);
          }}
          label="计划任务"
        />
      </section>
      <LearningPlanHistory />
    </article>
  );
}
