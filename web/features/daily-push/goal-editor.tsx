import { useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import type { LearningGoal } from '../../../shared/models/learning-plan';
import { Field, MultiSelect, useApp } from '../../shared/ui/components';
import './learning-plan.css';

export function newLearningGoal(domainId = '', categoryIds: string[] = []): LearningGoal {
  return {
    id: `goal-${crypto.randomUUID()}`,
    name: '新的学习目标',
    enabled: true,
    domainId,
    categoryIds,
    tagIds: [],
    tagMode: 'all',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    priority: 3,
    weight: 1,
    reviewPoints: 30,
    newPoints: 20,
    mode: 'focus',
    direction: 'default',
  };
}
export function GoalEditor({
  goals,
  onChange,
  fixed,
}: {
  goals: LearningGoal[];
  onChange: (goals: LearningGoal[]) => void;
  fixed: boolean;
}) {
  const { bootstrap } = useApp();
  const [expanded, setExpanded] = useState<string[]>(goals[0] ? [goals[0].id] : []);
  const change = (id: string, update: Partial<LearningGoal>) =>
    onChange(goals.map((goal) => (goal.id === id ? { ...goal, ...update } : goal)));
  return (
    <div className="learning-goal-editors">
      {goals.map((goal, index) => {
        const categories = bootstrap.categories.filter((c) => c.domainId === goal.domainId),
          tags = bootstrap.tags.filter((t) => !t.domainId || t.domainId === goal.domainId);
        return (
          <details
            className="learning-goal-editor"
            key={goal.id}
            onInvalidCapture={(event) => {
              event.currentTarget.open = true;
              setExpanded((old) => (old.includes(goal.id) ? old : [...old, goal.id]));
            }}
            open={expanded.includes(goal.id)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setExpanded((old) =>
                open
                  ? old.includes(goal.id)
                    ? old
                    : [...old, goal.id]
                  : old.filter((id) => id !== goal.id),
              );
            }}
          >
            <summary>
              <strong>
                {index + 1}. {goal.name || '未命名目标'}
              </strong>
              <span className="badge">{goal.enabled ? '启用' : '暂停'}</span>
              <span>
                {bootstrap.domains.find((d) => d.id === goal.domainId)?.name || '请选择领域'}
              </span>
              <ChevronDown size={16} />
            </summary>
            <div className="learning-goal-editor-body">
              <div className="learning-goal-heading">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={goal.enabled}
                    onChange={(e) => change(goal.id, { enabled: e.target.checked })}
                  />
                  启用此目标
                </label>
                <button
                  type="button"
                  className="button danger"
                  onClick={() => onChange(goals.filter((g) => g.id !== goal.id))}
                >
                  <Trash2 size={15} />
                  移除目标
                </button>
              </div>
              <div className="learning-plan-grid">
                <Field label="目标名称">
                  <input
                    maxLength={100}
                    value={goal.name}
                    onChange={(e) => change(goal.id, { name: e.target.value })}
                  />
                </Field>
                <Field label="学习领域">
                  <select
                    value={goal.domainId}
                    onChange={(e) =>
                      change(goal.id, { domainId: e.target.value, categoryIds: [], tagIds: [] })
                    }
                  >
                    <option value="">选择领域</option>
                    {bootstrap.domains.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <MultiSelect
                label="目标分类"
                values={goal.categoryIds}
                options={categories.map((c) => ({ id: c.id, name: c.name }))}
                onChange={(categoryIds) => change(goal.id, { categoryIds })}
                placeholder="至少一个分类，包含下级分类"
              />
              <MultiSelect
                label="目标标签（可选）"
                values={goal.tagIds}
                options={tags.map((t) => ({ id: t.id, name: t.name }))}
                onChange={(tagIds) => change(goal.id, { tagIds })}
              />
              <div className="learning-plan-grid">
                <Field label="标签匹配">
                  <select
                    value={goal.tagMode}
                    onChange={(e) => change(goal.id, { tagMode: e.target.value as 'all' | 'any' })}
                  >
                    <option value="all">满足全部标签</option>
                    <option value="any">满足任意标签</option>
                  </select>
                </Field>
                <Field label="目标优先级" hint="5最高；重叠任务优先分给高优先级目标。">
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={goal.priority}
                    onChange={(e) => change(goal.id, { priority: Number(e.target.value) })}
                  />
                </Field>
                {fixed ? (
                  <>
                    <Field label="本目标复习分值">
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step="0.01"
                        value={goal.reviewPoints}
                        onChange={(e) => change(goal.id, { reviewPoints: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="本目标新题分值">
                      <input
                        type="number"
                        min={0}
                        max={10000}
                        step="0.01"
                        value={goal.newPoints}
                        onChange={(e) => change(goal.id, { newPoints: Number(e.target.value) })}
                      />
                    </Field>
                  </>
                ) : (
                  <Field label="分配权重" hint="每天按参与目标的权重分配总预算。">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={goal.weight}
                      onChange={(e) => change(goal.id, { weight: Number(e.target.value) })}
                    />
                  </Field>
                )}
                <Field label="默认学习方式">
                  <select
                    value={goal.mode}
                    onChange={(e) =>
                      change(goal.id, { mode: e.target.value as 'focus' | 'practice' })
                    }
                  >
                    <option value="focus">专注复习</option>
                    <option value="practice">普通练习</option>
                  </select>
                </Field>
                <Field label="词汇与概念方向">
                  <select
                    value={goal.direction}
                    onChange={(e) =>
                      change(goal.id, { direction: e.target.value as LearningGoal['direction'] })
                    }
                  >
                    <option value="default">默认顺向，其他题正常练习</option>
                    <option value="word_to_meaning">顺向：看名称想含义</option>
                    <option value="meaning_to_word">逆向：看释义想名称</option>
                    <option value="both">分别安排顺向和逆向</option>
                  </select>
                </Field>
              </div>
              <fieldset className="learning-weekdays">
                <legend>学习日期</legend>
                {['一', '二', '三', '四', '五', '六', '日'].map((name, i) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      checked={goal.weekdays.includes(i + 1)}
                      onChange={(e) =>
                        change(goal.id, {
                          weekdays: e.target.checked
                            ? [...goal.weekdays, i + 1].sort()
                            : goal.weekdays.filter((d) => d !== i + 1),
                        })
                      }
                    />
                    周{name}
                  </label>
                ))}
              </fieldset>
            </div>
          </details>
        );
      })}
      <button
        type="button"
        className="button"
        disabled={goals.length >= 30}
        onClick={() => {
          const added = newLearningGoal();
          onChange([...goals, added]);
          setExpanded((old) => [...old, added.id]);
        }}
      >
        <Plus size={16} />
        添加学习目标
      </button>
      <p className="muted">
        最多30个目标。休息日不分配任务；跨目标重复的小题与词卡方向只安排一次。
      </p>
    </div>
  );
}
