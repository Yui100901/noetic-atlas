import { Plus, Trash2 } from 'lucide-react';
import { typeLabels } from '../../../shared/models/types';
import {
  coverageRuleKey,
  type PaperCoverageKind,
  type PaperCoverageReport,
  type PaperCoverageRequirements,
} from '../../../shared/ai/paper-coverage';
import { Field, useApp } from '../../shared/ui/components';
import './ai-paper-coverage.css';

const names: Record<PaperCoverageKind, string> = {
  category: '分类（含子类）',
  tag: '标签',
  type: '题型',
  difficulty: '难度',
};
export function paperCoverageInputValid(value: PaperCoverageRequirements) {
  return (
    value.rules.every(
      (rule) =>
        !!rule.value && Number.isInteger(rule.minimum) && rule.minimum >= 1 && rule.minimum <= 500,
    ) && new Set(value.rules.map(coverageRuleKey)).size === value.rules.length
  );
}
export function AiPaperCoverageEditor({
  value,
  onChange,
  count,
  disabled = false,
}: {
  value: PaperCoverageRequirements;
  onChange: (next: PaperCoverageRequirements) => void;
  count?: number;
  disabled?: boolean;
}) {
  const { bootstrap } = useApp();
  const options = (kind: PaperCoverageKind) =>
    kind === 'category'
      ? bootstrap.categories.map((category) => ({
          value: category.id,
          name: `${bootstrap.domains.find((domain) => domain.id === category.domainId)?.name || ''} / ${category.name}`,
        }))
      : kind === 'tag'
        ? bootstrap.tags.map((tag) => ({ value: tag.id, name: tag.name }))
        : kind === 'type'
          ? Object.entries(typeLabels).map(([value, name]) => ({ value, name }))
          : [1, 2, 3, 4].map((level) => ({ value: String(level), name: `D${level}` }));
  const change = (index: number, patch: Partial<PaperCoverageRequirements['rules'][number]>) =>
    onChange({
      ...value,
      rules: value.rules.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)),
    });
  const balance = () =>
    onChange({
      ...value,
      rules: value.rules.map((rule) => {
        if (!['type', 'difficulty'].includes(rule.kind)) return rule;
        const entries = value.rules.filter((row) => row.kind === rule.kind);
        const index = entries.indexOf(rule),
          total = count || 0;
        return {
          ...rule,
          minimum: Math.floor(total / entries.length) + Number(index < total % entries.length),
        };
      }),
    });
  const hasBalancedGroup = ['type', 'difficulty'].some(
    (kind) => value.rules.filter((rule) => rule.kind === kind).length >= 2,
  );
  const canBalance =
    hasBalancedGroup &&
    count !== undefined &&
    count > 0 &&
    count <= 500 &&
    ['type', 'difficulty'].every(
      (kind) => value.rules.filter((rule) => rule.kind === kind).length <= count,
    );
  return (
    <details className="ai-paper-coverage-editor">
      <summary>可选覆盖要求{value.rules.length ? ` · ${value.rules.length}项` : ''}</summary>
      <div className="form-stack">
        <p className="muted">
          在候选范围内指定各类至少选多少题。同题可满足多个分类或标签要求；组合题按整题计数。分类包含子类，覆盖要求不会放宽高级筛选。
        </p>
        <Field label="覆盖要求处理方式">
          <select
            value={value.enforcement}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...value,
                enforcement: event.target.value as PaperCoverageRequirements['enforcement'],
              })
            }
          >
            <option value="required">必须满足，未达到不能创建题集</option>
            <option value="advisory">作为建议，显示缺口但允许保存</option>
          </select>
        </Field>
        {value.rules.map((rule, index) => (
          <div className="ai-paper-coverage-rule" key={index}>
            <Field label={`第${index + 1}项覆盖类别`}>
              <select
                value={rule.kind}
                disabled={disabled}
                onChange={(event) => {
                  const kind = event.target.value as PaperCoverageKind;
                  change(index, {
                    kind,
                    value:
                      options(kind).find(
                        (item) =>
                          !value.rules.some(
                            (other, at) =>
                              at !== index && other.kind === kind && other.value === item.value,
                          ),
                      )?.value || '',
                  });
                }}
              >
                {Object.entries(names).map(([id, name]) => (
                  <option value={id} key={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`第${index + 1}项覆盖内容`}>
              <select
                value={rule.value}
                disabled={disabled}
                onChange={(event) => change(index, { value: event.target.value })}
              >
                <option value="">请选择</option>
                {options(rule.kind).map((item) => (
                  <option
                    value={item.value}
                    key={item.value}
                    disabled={value.rules.some(
                      (other, at) =>
                        at !== index && other.kind === rule.kind && other.value === item.value,
                    )}
                  >
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`第${index + 1}项最低题数`}>
              <input
                type="number"
                min={1}
                max={500}
                value={Number.isFinite(rule.minimum) ? rule.minimum : ''}
                disabled={disabled}
                onChange={(event) =>
                  change(index, { minimum: event.target.value ? Number(event.target.value) : 0 })
                }
              />
            </Field>
            <button
              type="button"
              className="button"
              aria-label={`删除第${index + 1}项覆盖要求`}
              disabled={disabled}
              onClick={() =>
                onChange({ ...value, rules: value.rules.filter((_, at) => at !== index) })
              }
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
        ))}
        <div className="action-row">
          <button
            type="button"
            className="button"
            disabled={disabled || value.rules.length >= 20}
            onClick={() =>
              onChange({
                ...value,
                rules: [
                  ...value.rules,
                  {
                    kind: 'type',
                    value:
                      options('type').find(
                        (item) =>
                          !value.rules.some(
                            (rule) => rule.kind === 'type' && rule.value === item.value,
                          ),
                      )?.value || '',
                    minimum: 1,
                  },
                ],
              })
            }
          >
            <Plus size={15} />
            添加覆盖项
          </button>
          {hasBalancedGroup && (
            <button
              type="button"
              className="button"
              disabled={disabled || !canBalance}
              onClick={balance}
            >
              按手动题量均分题型／难度最低数
            </button>
          )}
        </div>
        {hasBalancedGroup && !canBalance && (
          <p className="muted">填写有效的手动题量后，可为已添加的题型或难度均分最低数。</p>
        )}
        {!paperCoverageInputValid(value) && (
          <p className="notice error" role="alert">
            请选择有效且不重复的覆盖内容，最低题数为1—500。
          </p>
        )}
      </div>
    </details>
  );
}
export function AiPaperCoverageSummary({ report }: { report: PaperCoverageReport }) {
  const missing = report.rows.filter((row) => !row.met);
  return (
    <section className="ai-paper-coverage-summary" aria-label="题集覆盖情况">
      <div className="list-toolbar">
        <h3>实际覆盖情况</h3>
        <span className={`badge ${report.satisfied ? '' : 'warning'}`}>
          {report.satisfied ? '已满足全部要求' : `${missing.length}项未达到`}
        </span>
      </div>
      <p className="muted">
        当前{report.questionCount}道整题，依据已选题目的分类、标签、题型和难度统计，增删后即时更新。
      </p>
      <ul>
        {report.rows.map((row) => (
          <li key={coverageRuleKey(row)} className={row.met ? '' : 'coverage-missing'}>
            <strong>
              {names[row.kind]} · {row.label}
            </strong>
            <span>
              实际{row.actual} / 最低{row.minimum}
              {row.available !== undefined ? ` · 范围内${row.available}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {!report.satisfied && (
        <p
          className={`notice ${report.requirements.enforcement === 'required' ? 'error' : 'info'}`}
        >
          {report.requirements.enforcement === 'required'
            ? '请补足缺少的题目后再创建，或修改覆盖要求重新推荐。'
            : '当前为建议模式，可继续调整或保留缺口保存。'}
        </p>
      )}
      <p className="muted">
        题型：
        {Object.entries(report.types)
          .map(([type, n]) => `${typeLabels[type as keyof typeof typeLabels] || type} ${n}`)
          .join(' · ')}
        <br />
        难度：
        {Object.entries(report.difficulties)
          .map(([level, n]) => `D${level} ${n}`)
          .join(' · ') || '未标注'}
      </p>
    </section>
  );
}
