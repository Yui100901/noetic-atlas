import type { Question, QuestionInput } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import { questionEditorValue } from './question-editor-state';

/** Draft identity belongs to its context, never to user-editable form content. */
export function questionDraftForm(form: QuestionInput): Omit<QuestionInput, 'id'> {
  const { id: _id, ...value } = questionEditorValue(form as Question);
  return structuredClone(value);
}

export const questionDraftSignature = (form: QuestionInput, sources: string, reason: string) => {
  const { id: _id, ...value } = questionEditorValue(form as Question);
  return JSON.stringify([value, sources, reason]);
};

/** Restore authoring content wholesale, so absent optional card/part fields
 * disappear; publication state and identity always come from the current item. */
export function questionRevisionForm(
  content: Omit<QuestionInput, 'id' | 'status'>,
  current: QuestionInput,
): QuestionInput {
  return {
    ...structuredClone(content),
    ...(current.id ? { id: current.id } : {}),
    status: current.status,
  };
}

const labels: Record<string, string> = {
  title: '标题',
  type: '题型',
  stemMarkdown: '题干',
  answerMarkdown: '参考答案',
  explanationMarkdown: '解析',
  gradingRequirements: '判题要求',
  mathEnabled: '公式排版',
  options: '选项',
  correctAnswers: '客观答案',
  blanks: '填空答案',
  parts: '组合小题',
  vocabulary: '词汇卡',
  concept: '概念卡',
  categoryIds: '分类',
  tagIds: '标签',
  sourceRefs: '参考来源',
  sourceDocument: '原始资料',
  sourceAnchor: '来源位置',
  documentLinks: '原文关联',
  collection: '内容属性',
  difficulty: '难度',
  depth: '深度',
  frequency: '常见度',
  frequencyScope: '常见度范围',
  frequencyBasis: '常见度依据',
};
export const questionRevisionFieldLabel = (field: string) => labels[field] || field;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function questionContentDifferences(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Array<{ field: string; before: unknown; after: unknown }> {
  const excluded = new Set([
    'id',
    'status',
    'createdAt',
    'updatedAt',
    'study',
    'partStudies',
    'feedbackSummary',
  ]);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !excluded.has(field) && !same(before[field], after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

export function questionRevisionFieldText(field: string, value: unknown): string {
  if (value === undefined || value === null) return '未设置';
  if (field === 'type') return typeLabels[value as Question['type']] || String(value);
  if (field === 'mathEnabled') return value ? '开启' : '关闭';
  if (field === 'collection') return value === 'personal' ? '个人专项' : '通用知识';
  if (field === 'options' && Array.isArray(value))
    return value.map((item) => `${item.key}. ${item.text}`).join('\n') || '无';
  if (field === 'sourceRefs' && Array.isArray(value))
    return value.map((item) => `${item.label} | ${item.url}`).join('\n') || '无';
  return typeof value === 'string' ? value || '空内容' : JSON.stringify(value, null, 2);
}

/** A linear prefix/suffix comparison avoids quadratic diff work for long
 * Markdown. The complete source remains available with an explicit expansion. */
export function questionDiffExcerpt(before: string, after: string) {
  const left = before.split('\n'),
    right = after.split('\n');
  let start = 0,
    end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (
    end < left.length - start &&
    end < right.length - start &&
    left[left.length - 1 - end] === right[right.length - 1 - end]
  )
    end++;
  const from = Math.max(0, start - 2);
  const snippet = (lines: string[]) => {
    const to = Math.min(lines.length, lines.length - end + 2);
    const output = [
      ...(from ? [`…省略前${from}行…`] : []),
      ...lines.slice(from, Math.min(to, from + 80)),
      ...(to > from + 80 ? ['…中间内容较长，请展开完整内容…'] : []),
      ...(to < lines.length ? [`…省略后${lines.length - to}行…`] : []),
    ].join('\n');
    return output.slice(0, 12000) + (output.length > 12000 ? '\n…请展开完整内容…' : '');
  };
  return { before: snippet(left), after: snippet(right) };
}
