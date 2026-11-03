import type { Dispatch, SetStateAction } from 'react';
import type { DailyPushSettings } from '../../../shared/models/daily-push';
import { Field, MultiSelect, useApp } from '../../shared/ui/components';
import { GoalEditor, newLearningGoal } from './goal-editor';
import './daily-push.css';

/** Controlled fields share the system settings draft and saved version. */
export function DailyPushSettingsFields({
  form,
  onChange,
}: {
  form: DailyPushSettings;
  onChange: (value: DailyPushSettings) => void;
}) {
  const { bootstrap } = useApp();
  const setForm: Dispatch<SetStateAction<DailyPushSettings>> = (next) =>
    onChange(typeof next === 'function' ? next(form) : next);
  const multi = !!form.goals?.length,
    fixed = form.allocationMode === 'fixed';
  const set = <K extends keyof DailyPushSettings>(key: K, value: DailyPushSettings[K]) =>
    onChange({ ...form, [key]: value });
  const categories = bootstrap.categories.filter((c) => c.domainId === form.domainId),
    categoryMap = new Map(categories.map((c) => [c.id, c]));
  const options = categories.map((c) => {
    const names = [c.name],
      seen = new Set([c.id]);
    let parent = c.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const p = categoryMap.get(parent);
      if (!p) break;
      names.unshift(p.name);
      parent = p.parentId;
    }
    return { id: c.id, name: names.join(' / ') };
  });
  return (
    <section className="card settings-section daily-settings-section">
      <div className="daily-settings-heading">
        <div>
          <h2>每日推题与学习计划</h2>
          <p className="muted">安排多个学习目标，优先到期复习，再学习新题。</p>
        </div>
        <label className="daily-settings-switch">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          开启每日推题
        </label>
      </div>
      <div className="daily-settings-grid">
        <Field label="计划范围">
          <select
            value={multi ? 'multi' : 'single'}
            onChange={(e) =>
              setForm((old) =>
                e.target.value === 'multi'
                  ? { ...old, goals: [newLearningGoal(old.domainId || '', old.categoryIds)] }
                  : {
                      ...old,
                      domainId: old.goals?.[0]?.domainId || old.domainId,
                      categoryIds: old.goals?.[0]?.categoryIds || old.categoryIds,
                      goals: [],
                    },
              )
            }
          >
            <option value="single">单领域推荐</option>
            <option value="multi">多个学习目标</option>
          </select>
        </Field>
        {multi && (
          <Field label="预算分配方式">
            <select
              value={form.allocationMode || 'weights'}
              onChange={(e) => set('allocationMode', e.target.value as 'weights' | 'fixed')}
            >
              <option value="weights">按目标权重分配总预算</option>
              <option value="fixed">分别设置各目标分值</option>
            </select>
          </Field>
        )}
      </div>
      {(!multi || !fixed) && (
        <div className="daily-settings-grid daily-settings-points">
          <Field label="复习题目标分值" hint="默认30分，多目标共同使用这份预算。">
            <input
              required
              type="number"
              min={0}
              max={10000}
              step="0.01"
              value={form.reviewPoints}
              onChange={(e) => set('reviewPoints', Number(e.target.value))}
            />
          </Field>
          <Field label="新题目标分值" hint="默认20分，参与目标按权重分配。">
            <input
              required
              type="number"
              min={0}
              max={10000}
              step="0.01"
              value={form.newPoints}
              onChange={(e) => set('newPoints', Number(e.target.value))}
            />
          </Field>
        </div>
      )}
      {multi ? (
        <GoalEditor goals={form.goals!} fixed={fixed} onChange={(goals) => set('goals', goals)} />
      ) : (
        <>
          <div className="daily-settings-grid">
            <Field label="推题领域" hint="开启时必选一个领域。">
              <select
                required={form.enabled}
                value={form.domainId || ''}
                onChange={(e) =>
                  setForm((old) => ({
                    ...old,
                    domainId: e.target.value || null,
                    categoryIds: [],
                  }))
                }
              >
                <option value="">选择学习领域</option>
                {bootstrap.domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="daily-settings-summary">
              <span>每日目标</span>
              <strong>
                {Number((form.reviewPoints + form.newPoints).toFixed(2))} <small>分以上</small>
              </strong>
            </div>
          </div>
          <MultiSelect
            label="推题分类"
            options={options}
            values={form.categoryIds}
            onChange={(v) => set('categoryIds', v)}
            placeholder="查找分类，包含所选分类的下级分类"
          />
        </>
      )}
      <div className="notice info">
        <span>
          复习不足时补充新题；FSRS积压较多时优先复习。题目不足会显示缺口，其他目标有可用任务时可补足每日总量。分值表示学习量，完成任务与掌握知识分别记录。
        </span>
      </div>
      <details className="daily-settings-time">
        <summary>推题时间与时区</summary>
        <div className="daily-settings-grid">
          <Field label="每日推题时间">
            <input
              required
              type="time"
              value={form.scheduleTime}
              onChange={(e) => set('scheduleTime', e.target.value)}
            />
          </Field>
          <Field label="推题时区">
            <input
              required
              value={form.timeZone}
              onChange={(e) => set('timeZone', e.target.value)}
            />
          </Field>
        </div>
        <p className="muted">
          运行时按时生成；关闭后下次启动补齐当天安排。已经生成的任务保持稳定，目标修改从后续日期生效。
        </p>
      </details>
    </section>
  );
}
