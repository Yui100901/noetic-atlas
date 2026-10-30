import { BookOpen } from 'lucide-react';
import type { Question } from '../../../shared/models/types';
import { citationLocation, citationRelations } from '../../../shared/models/document-citations';
import { documentSourceHref } from './source-navigation';
import './document-sources.css';

/** Reading/review only. Never mount reference evidence inside an active test. */
export function QuestionCitations({
  question,
}: {
  question: Pick<Question, 'documentLinks' | 'sourceDocument' | 'sourceAnchor'>;
}) {
  if (!question.documentLinks?.length)
    return question.sourceDocument ? (
      <section className="card question-citations">
        <h2 className="card-title">
          <BookOpen size={17} />
          原文出处
        </h2>
        <p>
          {question.sourceDocument}
          {question.sourceAnchor ? ` · ${question.sourceAnchor}` : ''}
        </p>
        <p className="muted">尚未关联资料库原文，可在编辑题目时选择对应教材。</p>
      </section>
    ) : null;
  return (
    <section className="card question-citations" aria-label="题目原文出处">
      <h2 className="card-title">
        <BookOpen size={17} />
        原文出处
      </h2>
      <div className="source-citation-list">
        {question.documentLinks.map((citation, index) => (
          <article key={index} className="source-citation">
            <div className="source-citation-heading">
              <div>
                <strong>{citation.title}</strong>
                <p className="muted">
                  {citationRelations[citation.relation]} · {citationLocation(citation)}
                </p>
              </div>
              {citation.documentId && citation.versionId ? (
                <a className="button" href={documentSourceHref(citation, window.location.hash)}>
                  <BookOpen size={15} />
                  查看原文
                </a>
              ) : (
                <span className="badge">原文未随包附带</span>
              )}
            </div>
            {citation.excerpt && (
              <details>
                <summary>引用摘录</summary>
                <blockquote className="source-excerpt">{citation.excerpt}</blockquote>
              </details>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
