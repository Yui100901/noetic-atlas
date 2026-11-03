import { MarkdownEditor } from '../../shared/ui/markdown-editor';
import './question-grading.css';
import { Markdown } from '../../shared/ui/components';
import type { VocabularyDirection } from '../../../shared/models/types';
import {
  forwardCardGradingTitle,
  isDirectionalCard,
  reverseCardGradingRequirements,
  reverseCardGradingTitle,
} from '../../../shared/questions/directional-grading';

/** Source rubrics are reusable; set overrides never write back through this field. */
export function QuestionGradingRequirementsField({
  value,
  onChange,
  label = '原题判题要求',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
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
      placeholder={'必要要点：…\n正确：…\n部分正确：…\n错误及边界：…'}
    />
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
