import { ArrowDown, ArrowUp, Check, Trash2 } from 'lucide-react';
import type { PaperPreview, Question, QuestionPart } from '../../../shared/models/types';
import {
  forwardCardGradingTitle,
  isDirectionalCard,
  reverseCardGradingRequirements,
  reverseCardGradingTitle,
} from '../../../shared/questions/directional-grading';
import { isSubjectiveType } from '../../../shared/questions/question-utils';
import { pointText } from '../../shared/lib/scoring';
import { ErrorNotice, Field, Markdown, Modal, Pagination } from '../../shared/ui/components';
import { QuestionContentPreview } from '../questions/question-content-preview';
import {
  QuestionGradingRequirementsField,
  QuestionGradingRequirements,
} from '../questions/question-grading';
import './paper-preview.css';

export interface PaperPreviewControls {
  questionGradingRequirements: Record<string, string>;
  onRequirement: (id: string, value: string | undefined) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
  onPoints?: (id: string, value: number) => void;
  points: Record<string, number>;
}

/** A full reading preview is separate from attempting a paper. Its controls
 * change only the owning authoring form; reference links never leave it. */
export function PaperPreviewDialog({
  paper,
  ids,
  title,
  commonRequirements,
  controls,
  busy = false,
  random = false,
  onClose,
  onConfirm,
  onPage,
  onPageSize,
  error,
  onRetry,
  confirmLabel = '保留调整并返回组题',
}: {
  paper: PaperPreview;
  ids: string[];
  title: string;
  commonRequirements: string;
  controls: PaperPreviewControls;
  busy?: boolean;
  random?: boolean;
  error?: string;
  onRetry?: () => void;
  onClose: () => void;
  onConfirm?: () => void;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  confirmLabel?: string;
}) {
  const questions = paper.previewQuestions;
  const paging = {
    page: paper.previewPage,
    pageSize: paper.previewPageSize,
    total: ids.length,
    onPage,
  };
  const rubric = (root: Question, question: Question | QuestionPart) => {
    if (!isSubjectiveType(question.type)) return null;
    const id = question === root ? root.id : `${root.id}::${question.id}`;
    const custom = Object.hasOwn(controls.questionGradingRequirements, id);
    const original = paper.inheritedGradingRequirements[id] ?? question.gradingRequirements ?? '';
    return (
      <section className="preview-rubric" key={id} aria-label={`${id} 判题标准`}>
        <div className="preview-rubric-heading">
          <strong>
            {question === root ? forwardCardGradingTitle(question) : `${question.title} · 判题标准`}
          </strong>
          <span className="badge">{custom ? '本集自定义' : '沿用原题标准'}</span>
        </div>
        <Field label={`${id} 判题要求来源`}>
          <select
            disabled={busy}
            value={custom ? 'custom' : 'inherit'}
            onChange={(event) =>
              controls.onRequirement(id, event.target.value === 'inherit' ? undefined : original)
            }
          >
            <option value="inherit">沿用原题标准</option>
            <option value="custom">本集自定义</option>
          </select>
        </Field>
        <details className="preview-original-rubric" open={!custom}>
          <summary>{isDirectionalCard(question) ? '原题正向判题要求' : '原题判题要求'}</summary>
          <Markdown mathEnabled={question.mathEnabled ?? root.mathEnabled}>
            {original || '原题未设置判题要求，默认按题目、参考答案和解析评价。'}
          </Markdown>
        </details>
        {custom && (
          <QuestionGradingRequirementsField
            label={`${id} 本集判题要求`}
            value={controls.questionGradingRequirements[id]}
            disabled={busy}
            mathEnabled={question.mathEnabled ?? root.mathEnabled}
            onChange={(value) => controls.onRequirement(id, value)}
          />
        )}
        {isDirectionalCard(question) && (
          <QuestionGradingRequirements
            value={reverseCardGradingRequirements(question)}
            title={reverseCardGradingTitle(question)}
          />
        )}
      </section>
    );
  };
  return (
    <Modal title="全卷预览与调整" wide onClose={() => !busy && onClose()}>
      <div className="paper-full-preview">
        <header className="preview-summary">
          <h3>{title.trim() || '未命名题集'}</h3>
          <p>
            {ids.length} 道选题 ·{' '}
            {paper.scoring?.enabled
              ? `当前合计 ${pointText(ids.reduce((total, id) => total + (controls.points[id] || 0), 0))} 分`
              : '不计分'}{' '}
            · 调整会同步保存到组题表单与草稿
          </p>
          {random && (
            <p className="notice info">
              本次随机结果已锁定，保存时沿用这些题目。移除题目或调整逐题分值将转为手动组题；不会再次随机。
            </p>
          )}
          {commonRequirements && (
            <details>
              <summary>全卷补充判题要求</summary>
              <p className="preview-common-requirements">{commonRequirements}</p>
            </details>
          )}
        </header>
        {error && <ErrorNotice message={error} retry={onRetry} />}
        <Field label="每页预览题数">
          <select
            disabled={busy}
            value={paper.previewPageSize}
            onChange={(event) => onPageSize(Number(event.target.value))}
          >
            {[5, 10, 20].map((size) => (
              <option key={size} value={size}>
                {size}题
              </option>
            ))}
          </select>
        </Field>
        <Pagination {...paging} label="全卷预览" />
        <div
          className="preview-question-list"
          onClickCapture={(event) => {
            const link = (event.target as HTMLElement).closest('a');
            if (link?.getAttribute('href')?.startsWith('#/')) event.preventDefault();
          }}
        >
          {questions.map((question) => {
            const index = ids.indexOf(question.id);
            return (
              <article
                className="preview-question-card"
                key={question.id}
                data-preview-question={question.id}
              >
                <header>
                  <div>
                    <span className="section-label">
                      第 {index + 1} 题 · {question.id}
                    </span>
                    <h3>{question.title}</h3>
                  </div>
                  <div className="preview-question-actions">
                    <button
                      type="button"
                      className="button"
                      aria-label={`${question.id} 上移`}
                      disabled={busy || index === 0}
                      onClick={() => controls.onMove(question.id, -1)}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      className="button"
                      aria-label={`${question.id} 下移`}
                      disabled={busy || index === ids.length - 1}
                      onClick={() => controls.onMove(question.id, 1)}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      type="button"
                      className="button danger-text"
                      aria-label={`${question.id} 移除`}
                      disabled={busy}
                      onClick={() => controls.onRemove(question.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </header>
                {paper.scoring?.enabled && controls.onPoints && (
                  <Field label={`${question.id} 预览分值`}>
                    <input
                      type="number"
                      min={0.01}
                      max={1000}
                      step={0.01}
                      disabled={busy}
                      value={
                        Number.isFinite(controls.points[question.id])
                          ? controls.points[question.id]
                          : ''
                      }
                      onChange={(event) =>
                        controls.onPoints?.(
                          question.id,
                          event.target.value === '' ? NaN : Number(event.target.value),
                        )
                      }
                    />
                  </Field>
                )}
                <QuestionContentPreview question={question} showGradingRequirements={false} />
                {question.type === 'group'
                  ? question.parts?.map((part) => rubric(question, part))
                  : rubric(question, question)}
              </article>
            );
          })}
        </div>
        <Pagination {...paging} label="全卷预览" />
        <footer className="preview-footer">
          <span className="muted">题干、参考答案、解析与判题标准供组题核对；不产生作答记录。</span>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={onConfirm || onClose}
          >
            <Check size={16} />
            {confirmLabel}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
