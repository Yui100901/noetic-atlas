import { useState } from 'react';
import { ChevronDown, ChevronRight, Star } from 'lucide-react';
import type { Question } from '../../../shared/models/types';
import { QuestionMeta, Tags } from '../../shared/ui/components';
import { QuestionFeedbackBadge } from '../quality-feedback/report-question';
import { libraryQuestionHref, rememberLibraryScroll } from './library-navigation';
import { QuestionPreview } from './question-preview';

// Library rows preserve the return location. Selectable authoring rows expand
// in place so selecting or inspecting candidates never leaves the draft.
export function QuestionRow({
  question,
  selectable,
  checked,
  onCheck,
  returnTo,
}: {
  question: Question;
  selectable?: boolean;
  checked?: boolean;
  onCheck?: () => void;
  returnTo?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article
      onClick={() => {
        if (returnTo) rememberLibraryScroll(returnTo);
      }}
      className={`question-row ${checked ? 'is-checked' : ''} ${expanded ? 'is-expanded' : ''}`}
    >
      <div className="question-row-summary">
        {selectable && (
          <input
            className="question-checkbox"
            aria-label={`选择 ${question.id}${question.status !== 'published' ? '（未发布，不可用于组卷）' : ''}`}
            type="checkbox"
            checked={checked}
            disabled={question.status !== 'published'}
            onChange={onCheck}
          />
        )}
        <div className="question-row-content">
          <QuestionMeta question={question} />
          <QuestionFeedbackBadge questionId={question.id} />
          {question.status !== 'published' && (
            <span className="badge status-muted">
              {question.status === 'pending'
                ? '待审核'
                : question.status === 'draft'
                  ? '草稿'
                  : '已归档'}
              {selectable ? ' · 不可用于组卷' : ''}
            </span>
          )}
          {selectable ? (
            <button
              type="button"
              className="question-title text-button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {question.title}
            </button>
          ) : (
            <a className="question-title" href={libraryQuestionHref(question.id, returnTo)}>
              {question.title}
            </a>
          )}
          <Tags ids={question.tagIds} max={5} />
        </div>
        <div className="question-row-side">
          {question.study?.favorite && (
            <Star size={16} className="favorite-icon" fill="currentColor" />
          )}
          {question.type === 'group' ? (
            <span className="mastery-mini">
              小题已自评{' '}
              {question.partStudies?.filter((state) => state.mastery != null).length || 0}/
              {question.parts?.length || 0}
            </span>
          ) : (
            question.study?.mastery !== null &&
            question.study?.mastery !== undefined && (
              <span className="mastery-mini">掌握 {question.study.mastery}/3</span>
            )
          )}
          {selectable ? (
            <button
              type="button"
              className="icon-link"
              aria-label={`${expanded ? '收起' : '展开'} ${question.title}`}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <ChevronDown size={18} className={expanded ? 'rotated' : ''} />
            </button>
          ) : (
            <a
              className="icon-link"
              href={libraryQuestionHref(question.id, returnTo)}
              aria-label={`查看 ${question.title}`}
            >
              <ChevronRight size={18} />
            </a>
          )}
        </div>
      </div>
      {selectable && expanded && <QuestionPreview question={question} />}
    </article>
  );
}
