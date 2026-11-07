import {
  AI_IMPORT_HARD_LIMITS,
  DEFAULT_AI_IMPORT_LIMITS,
  type AiImportLimits,
} from '../../../shared/ai/import-limits';
import type { ReactNode } from 'react';
import { DEFAULT_SETTINGS, type SystemSettings } from '../../../shared/models/settings';
import { typeLabels, type QuestionType } from '../../../shared/models/types';
import { Field } from '../../shared/ui/components';
import { ThemePicker } from '../../shared/theme/theme-picker';
import { DailyPushSettingsFields } from '../daily-push/daily-settings';
import { ReviewSchedulingSettings } from '../review-scheduler/review-settings';
import type { SettingsRoute } from './settings-navigation';

export type SettingsSetter = <K extends keyof SystemSettings>(
  key: K,
  value: SystemSettings[K],
) => void;
export function SettingsFields({
  value: form,
  onChange: set,
  route,
  busy,
}: {
  value: SystemSettings;
  onChange: SettingsSetter;
  route: SettingsRoute;
  busy: boolean;
}) {
  const materialFields: Array<{ key: keyof AiImportLimits; label: string; min: number }> = [
    { key: 'fileMiB', label: 'AI材料单文件上限（MiB）', min: 1 },
    { key: 'totalMiB', label: 'AI材料每次总大小上限（MiB）', min: 1 },
    { key: 'files', label: 'AI材料每次最多文件数', min: 1 },
    { key: 'pdfPages', label: 'AI材料单份PDF最多页数', min: 1 },
    { key: 'sourceCharacters', label: 'AI任务提取正文最多字符数', min: 1000 },
    { key: 'sourceMiB', label: 'AI任务提取正文上限（MiB）', min: 1 },
    { key: 'blocks', label: 'AI任务最多资料块数', min: 1 },
  ];
  const panel = (tab: SettingsRoute['tab'], sub: string, children: ReactNode) => (
    <div
      className="settings-fields-panel ui-stack"
      data-settings-tab={tab}
      data-settings-sub={sub}
      hidden={route.tab !== tab || route.sub !== sub}
    >
      {children}
    </div>
  );
  const number = (
    key: keyof SystemSettings,
    label: string,
    min: number,
    max: number,
    hint?: string,
    step = 1,
  ) => (
    <div className="settings-option">
      <Field label={label}>
        <input
          required
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={form[key] as number}
          onChange={(event) => set(key, Number(event.target.value) as never)}
        />
      </Field>
      {hint && (
        <details className="settings-field-help">
          <summary aria-label={`${label}的说明`}>使用说明</summary>
          <p>{hint}</p>
        </details>
      )}
    </div>
  );
  return (
    <>
      {panel(
        'general',
        '',
        <>
          <section className="card settings-section settings-appearance">
            <h2>外观主题</h2>
            <ThemePicker value={form.theme} onChange={(value) => set('theme', value)} />
          </section>
          <section className="card settings-section">
            <h2>自动保存</h2>
            {number(
              'autosaveDebounceMs',
              '编辑与作答自动保存等待（毫秒）',
              100,
              10000,
              '输入停止后等待此时长保存；离开页面仍尝试保存。',
            )}
          </section>
        </>,
      )}
      {panel(
        'practice',
        '',
        <>
          <section className="card settings-section settings-defaults">
            <h2>组题与考试默认值</h2>
            <div className="check-row">
              <label>
                <input
                  type="checkbox"
                  checked={form.scoringEnabledByDefault}
                  onChange={(event) => set('scoringEnabledByDefault', event.target.checked)}
                />
                新建题集默认启用计分
              </label>
            </div>
            <div className="form-grid">
              {number(
                'examDurationMinutes',
                '考试模式默认时长（分钟）',
                1,
                1440,
                '默认120分钟，每次开始考试前仍可调整。',
              )}
              {number('randomQuestionCount', '随机无分练习默认题量', 1, 500)}
              {number('randomTotalPoints', '随机计分默认总分', 0.01, 10000, undefined, 0.01)}
              {number(
                'objectivePercent',
                '客观题默认目标占比（%）',
                0,
                100,
                `主观题目标 ${100 - form.objectivePercent}%；默认60% / 40%。`,
                0.01,
              )}
            </div>
            <p className="muted">
              只影响之后新建的题集，已保存分值、已开始草稿和历史成绩保持原样。
            </p>
          </section>
          <section className="card settings-section">
            <h2>每题型默认分值</h2>
            <div className="form-grid settings-points-grid">
              {Object.entries(typeLabels).map(([type, label]) => (
                <Field
                  key={type}
                  label={`${label}默认分值`}
                  hint={type === 'group' ? '整组分值按各小题权重分配。' : undefined}
                >
                  <input
                    required
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={form.pointsByType[type as QuestionType]}
                    onChange={(event) =>
                      set('pointsByType', {
                        ...form.pointsByType,
                        [type]: Number(event.target.value),
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          </section>
        </>,
      )}
      {panel(
        'review',
        'scheduler',
        <>
          <ReviewSchedulingSettings
            value={form.reviewScheduling}
            onChange={(value) => set('reviewScheduling', value)}
            disabled={busy}
          />
          <section className="card settings-section settings-review">
            <h2>固定复习间隔</h2>
            <div className="form-grid">
              {form.reviewIntervalsDays.map((days, index) => (
                <Field
                  key={index}
                  label={`${['不会', '需提示', '能独立', '能深入'][index]}的复习间隔（天）`}
                >
                  <input
                    required
                    type="number"
                    min="0"
                    max="3650"
                    step="1"
                    value={days}
                    onChange={(event) =>
                      set(
                        'reviewIntervalsDays',
                        form.reviewIntervalsDays.map((day, at) =>
                          at === index ? Number(event.target.value) : day,
                        ) as SystemSettings['reviewIntervalsDays'],
                      )
                    }
                  />
                </Field>
              ))}
            </div>
            <p className="muted">选择固定调度时使用。0天表示当天复习，只影响之后新记录的安排。</p>
          </section>
        </>,
      )}
      {panel(
        'review',
        'daily',
        <DailyPushSettingsFields
          form={form.dailyPush}
          onChange={(value) => set('dailyPush', value)}
        />,
      )}
      {panel(
        'retention',
        'content',
        <section className="card settings-section">
          <h2>内容编辑与版本</h2>
          <div className="form-grid">
            {number(
              'maxPaperDrafts',
              '每个组题上下文最多草稿数',
              1,
              100,
              '默认3，新建与每份已有题集分别保留，继续编辑覆盖同一草稿。',
            )}
            {number(
              'maxDocumentDrafts',
              '每个资料编辑入口最多草稿数',
              1,
              100,
              '默认3，新建与每份已有资料分别保留。',
            )}
            {number(
              'maxQuestionDrafts',
              '每个题目编辑入口最多草稿数',
              1,
              100,
              '默认3，新题与各个已有题目的编辑草稿分别保留。',
            )}
            {number(
              'maxQuestionRevisions',
              '每题最多内容修订版本',
              1,
              100,
              '默认20，供比较与恢复，不改变历史答卷。',
            )}
          </div>
          <p className="muted">
            继续编辑会更新原草稿，新建超限时清理最旧草稿。调低限制会先展示将要清理的数量。
          </p>
        </section>,
      )}
      {panel(
        'retention',
        'learning',
        <section className="card settings-section">
          <h2>学习草稿与作答历史</h2>
          <div className="form-grid">
            {number('maxDraftsPerPaper', '每题集最多草稿数', 1, 100, '默认3，继续答题覆盖原草稿。')}
            {number('maxQuickDrafts', '随机自测最多草稿数', 1, 100, '默认3，与题集分别保留。')}
            {number(
              'maxHistoryPerPaper',
              '每题集最多已提交整卷历史',
              0,
              10000,
              '默认0表示不限量，非0仅保留最近提交的整卷。',
            )}
            {number('maxQuickHistory', '随机自测最多已提交整卷历史', 0, 10000, '默认0表示不限量。')}
            {number(
              'maxQuestionHistory',
              '每题最多完整作答历史',
              0,
              10000,
              '默认10，跨题集合并保留最近实际填写的作答；0关闭详细历史，累计统计保留。',
            )}
          </div>
          <details className="settings-section-help">
            <summary>整卷与单题历史的保留关系</summary>
            <p className="muted">
              两种历史分别保留。清理整卷时，保留范围内的单题作答仍可查看；清理单题详细历史不减少累计统计，也不删除仍保留的整卷。调低限制会先预览清理数量。错题状态、来源摘要、复习、收藏、笔记和掌握记录继续保留。
            </p>
          </details>
        </section>,
      )}
      {panel(
        'assets',
        'uploads',
        <section className="card settings-section settings-files">
          <h2>文件上传限制</h2>
          <div className="form-grid">
            {number(
              'maxDocumentMiB',
              '单份MD / PDF上限（MiB）',
              1,
              50,
              `默认${DEFAULT_SETTINGS.maxDocumentMiB} MiB。`,
            )}
            {number(
              'maxImageMiB',
              '单张图片上限（MiB）',
              1,
              20,
              '默认5 MiB，支持 PNG、JPEG、WebP 和 GIF。',
            )}
          </div>
          <h3>AI 整理材料</h3>
          <div className="form-grid">
            {materialFields.map(({ key, label, min }) => (
              <div className="settings-option" key={key}>
                <Field label={label}>
                  <input
                    required
                    type="number"
                    min={min}
                    max={AI_IMPORT_HARD_LIMITS[key]}
                    disabled={busy}
                    value={form.aiImport[key]}
                    onChange={(event) =>
                      set('aiImport', { ...form.aiImport, [key]: Number(event.target.value) })
                    }
                  />
                </Field>
                <small>默认 {DEFAULT_AI_IMPORT_LIMITS[key].toLocaleString()}。</small>
              </div>
            ))}
          </div>
          <p className="muted">
            原始文件在本机提取，任务正文按大小和分块数再次校验。大材料使用分批处理；这些限额不会放大单次模型上下文。
          </p>
          <p className="muted">
            只影响后续上传。已有文件继续保留，可在“文件管理”中查看和清理未引用资源。
          </p>
        </section>,
      )}
    </>
  );
}
