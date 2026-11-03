import { Field } from '../../shared/ui/components';
import './grading-requirements.css';

/** Common additions complement the reusable per-question grading standard. */
export function PaperGradingRequirementsField({
  value,
  onChange,
  busy = false,
}: {
  value: string;
  onChange: (value: string) => void;
  busy?: boolean;
}) {
  return (
    <Field
      label="全卷补充判题要求（可选）"
      hint="在每题标准之外，补充本集统一的宽严程度、表达或部分正确要求。逐题标准可在全卷预览中沿用原题或自定义；这里留空仍会使用各题标准。"
    >
      <textarea
        rows={3}
        maxLength={10000}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例如：基础练习重在理解，允许等价表达；说明核心含义即可，遗漏非关键细节可判部分正确。"
      />
    </Field>
  );
}

/** Only render this outside an active answer session, to avoid giving hints. */
export function PaperGradingRequirements({
  value,
  title = '全卷补充判题要求',
}: {
  value?: string;
  title?: string;
}) {
  if (!value?.trim()) return null;
  return (
    <details className="paper-grading-requirements">
      <summary>{title}</summary>
      <p>{value}</p>
    </details>
  );
}
