import { useEffect, useRef, useState } from 'react';
import { MarkdownEditor } from '../../shared/ui/markdown-editor';
import './question-grading.css';
import { Markdown } from '../../shared/ui/components';
import { useMathEnabled } from '../../shared/math/math-context';
import type { VocabularyDirection } from '../../../shared/models/types';
import type { RubricFormatIssue } from '../../../shared/questions/rubric-format';
import {
  forwardCardGradingTitle,
  isDirectionalCard,
  reverseCardGradingRequirements,
  reverseCardGradingTitle,
} from '../../../shared/questions/directional-grading';

/** A local advisory preview, independent from saved quality findings. Delayed
 * module loads and inspections may only describe their own still-current text. */
function RubricQualityHints({
  value,
  label,
  mathEnabled,
  disabled,
  onLocate,
}: {
  value: string;
  label: string;
  mathEnabled: boolean;
  disabled: boolean;
  onLocate: (issue: RubricFormatIssue) => void;
}) {
  const [result, setResult] = useState<{
    value: string;
    mathEnabled: boolean;
    issues: RubricFormatIssue[];
    unavailable?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!value.trim()) return;
    let active = true;
    const timer = setTimeout(() => {
      void Promise.all([
        import('../../../shared/questions/rubric-format'),
        mathEnabled ? import('../../../shared/math/engine') : Promise.resolve(null),
      ])
        .then(([format, math]) => {
          if (!active) return;
          const issues = format.inspectRubricFormat(value);
          if (math)
            issues.push(
              ...math.inspectMathMarkdown(value).map((issue) => {
                const line = value.slice(0, issue.offset).split(/\r\n|\r|\n/).length;
                return {
                  ...issue,
                  code: 'math_syntax',
                  line,
                  message: `公式：${issue.message}（第${line}行）`,
                };
              }),
            );
          setResult({ value, mathEnabled, issues });
        })
        .catch(() => {
          if (active) setResult({ value, mathEnabled, issues: [], unavailable: true });
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [value, mathEnabled]);
  if (!value.trim() || result?.value !== value || result.mathEnabled !== mathEnabled) return null;
  if (result.unavailable)
    return (
      <p className="muted rubric-format-unavailable" role="status">
        暂未完成格式检查，可保存后在质量管理中扫描。
      </p>
    );
  if (!result.issues.length) return null;
  return (
    <details className="rubric-format-hints" aria-label={`${label}格式提示`}>
      <summary>发现 {result.issues.length} 项格式提示</summary>
      <p className="muted">
        仅检查格式与公式排版，不影响保存。已保存内容可在质量管理中扫描并处理。
      </p>
      <ul>
        {result.issues.slice(0, 8).map((issue, index) => (
          <li key={`${issue.code}-${issue.offset ?? index}`}>
            <div className="rubric-format-hint-heading">
              <span>{issue.message}</span>
              {issue.offset !== undefined && (
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled}
                  onClick={() => onLocate(issue)}
                >
                  定位{issue.line ? `第${issue.line}行` : '原文'}
                </button>
              )}
            </div>
            {issue.source && (
              <pre>
                {issue.source.slice(0, 240)}
                {issue.source.length > 240 ? '…' : ''}
              </pre>
            )}
          </li>
        ))}
      </ul>
      {result.issues.length > 8 && <p className="muted">先展示前8项，修改后将重新检查剩余内容。</p>}
    </details>
  );
}

/** Source rubrics are reusable; set overrides never write back through this field. */
export function QuestionGradingRequirementsField({
  value,
  onChange,
  label = '原题判题要求',
  disabled = false,
  mathEnabled,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  mathEnabled?: boolean;
}) {
  const enabled = useMathEnabled(mathEnabled);
  const editor = useRef<HTMLDivElement>(null);
  const locate = (issue: RubricFormatIssue) => {
    const wrapper = editor.current;
    if (!wrapper || issue.offset === undefined || disabled) return;
    wrapper.querySelector<HTMLButtonElement>('[role="tab"][id$="-write-tab"]')?.click();
    requestAnimationFrame(() => {
      const field = wrapper.querySelector<HTMLTextAreaElement>('textarea');
      if (!field?.isConnected || field.disabled || field.value !== value) return;
      const start = Math.max(0, Math.min(issue.offset!, value.length));
      const end = Math.min(value.length, start + Math.max(1, issue.source?.length || 1));
      field.focus();
      field.setSelectionRange(start, end);
      field.scrollIntoView({ block: 'center' });
    });
  };
  return (
    <div className="question-grading-field" ref={editor}>
      <MarkdownEditor
        label={label}
        heading={`${label} Markdown`}
        hint="说明本题必要得分点、可接受的等价表达、部分正确与错误的界限；可补充推理、单位或边界条件。题集默认沿用，也可只在题集中修改。"
        compact
        rows={6}
        maxLength={10000}
        value={value}
        disabled={disabled}
        onChange={onChange}
        allowImages={false}
        mathEnabled={mathEnabled}
        placeholder={'必要要点：…\n正确：…\n部分正确：…\n错误及边界：…'}
      />
      <RubricQualityHints
        value={value}
        label={label}
        mathEnabled={enabled}
        disabled={disabled}
        onLocate={locate}
      />
    </div>
  );
}

export function QuestionGradingRequirements({
  value,
  title = '本题判题要求',
  mathEnabled = false,
}: {
  value?: string;
  title?: string;
  mathEnabled?: boolean;
}) {
  if (!value?.trim()) return null;
  return (
    <details className="question-grading-requirements">
      <summary>{title}</summary>
      <Markdown mathEnabled={mathEnabled}>{value}</Markdown>
    </details>
  );
}

/** Call only from an answer/reference view. An active attempt must never render
 * aliases through this component. Frozen card metadata remains its only input. */
export function DirectionalGradingRequirements({
  question,
  direction,
  mathEnabled = false,
  historical = false,
}: {
  question: unknown;
  direction?: VocabularyDirection;
  mathEnabled?: boolean;
  historical?: boolean;
}) {
  const source =
    question && typeof question === 'object'
      ? (question as { type?: string; gradingRequirements?: string })
      : {};
  const card = isDirectionalCard(question),
    reverseOnly = direction === 'meaning_to_word' || (card && source.type === 'fill_blank');
  const prefix = historical ? '当时的' : '';
  return (
    <>
      {!reverseOnly && (
        <QuestionGradingRequirements
          value={source.gradingRequirements}
          title={
            historical && !card ? '当时本题的判题要求' : prefix + forwardCardGradingTitle(question)
          }
          mathEnabled={mathEnabled}
        />
      )}
      {card && direction !== 'word_to_meaning' && (
        <QuestionGradingRequirements
          value={reverseCardGradingRequirements(question)}
          title={prefix + reverseCardGradingTitle(question)}
        />
      )}
    </>
  );
}
