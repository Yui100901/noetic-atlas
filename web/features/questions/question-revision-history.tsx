import { useEffect, useState } from 'react';
import type {
  QuestionRevisionDetail,
  QuestionRevisionSummary,
  QuestionMaintenancePage,
} from '../../../shared/models/question-maintenance';
import { idPath, localDate, qs, useResource } from '../../shared/lib/api';
import { ErrorNotice, Loading, Pagination } from '../../shared/ui/components';
import {
  questionDiffExcerpt,
  questionRevisionFieldLabel,
  questionRevisionFieldText,
} from './question-maintenance-state';

const origins = {
  baseline: '初始内容',
  manual: '手动编辑',
  restore: '版本恢复',
  pending_import: '待审批量更新',
  ai_review: 'AI审核建议',
};

function RevisionDifference({
  field,
  before,
  after,
}: {
  field: string;
  before: unknown;
  after: unknown;
}) {
  const [full, setFull] = useState(false);
  const original = questionRevisionFieldText(field, before),
    current = questionRevisionFieldText(field, after);
  const excerpt = questionDiffExcerpt(original, current);
  const abbreviated = excerpt.before !== original || excerpt.after !== current;
  return (
    <details
      className="question-revision-field"
      open={['title', 'stemMarkdown', 'answerMarkdown', 'gradingRequirements'].includes(field)}
    >
      <summary>{questionRevisionFieldLabel(field)}</summary>
      <div className="question-revision-diff">
        <div>
          <span>所选修订内容</span>
          <pre>{full ? original : excerpt.before}</pre>
        </div>
        <div>
          <span>当前已保存内容</span>
          <pre>{full ? current : excerpt.after}</pre>
        </div>
      </div>
      {abbreviated && (
        <button className="text-button" type="button" onClick={() => setFull(!full)}>
          {full ? '仅查看差异附近' : '展开完整字段内容'}
        </button>
      )}
    </details>
  );
}

/** Lists fetch small headers; only the explicitly selected version loads its body. */
export function QuestionRevisionHistory({
  questionId,
  refreshKey,
  disabled,
  onLoad,
  onRestore,
}: {
  questionId: string;
  refreshKey: number;
  disabled: boolean;
  onLoad: (revision: QuestionRevisionDetail) => void;
  onRestore: (revision: QuestionRevisionDetail) => void;
}) {
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(5),
    [selected, setSelected] = useState('');
  const base = `/api/questions/${idPath(questionId)}/revisions`;
  const listUrl = `${base}?${qs({ page, pageSize })}`,
    detailUrl = selected ? `${base}/${idPath(selected)}` : null;
  const list = useResource<QuestionMaintenancePage<QuestionRevisionSummary>>(listUrl);
  const detail = useResource<QuestionRevisionDetail>(detailUrl);
  useEffect(() => {
    list.refresh();
    detail.refresh();
  }, [refreshKey, list.refresh, detail.refresh]);
  return (
    <section className="question-revision-history form-stack" aria-label="题目修订历史">
      <div>
        <h2>修订历史</h2>
        <p className="muted">
          查看与当前已保存原题的差异。载入编辑器可继续修改；恢复会保存为新修订。已有题集和答卷继续保留当时内容。
        </p>
      </div>
      {list.loading || (list.dataUrl !== listUrl && !list.error) ? (
        <Loading text="正在读取修订摘要…" />
      ) : list.error ? (
        <ErrorNotice message={list.error} retry={list.refresh} />
      ) : !list.data?.total ? (
        <p className="muted">还没有修订记录。首次修改保存时会保留原内容和新版本。</p>
      ) : (
        <>
          <div className="question-maintenance-list">
            {list.data.items.map((item) => (
              <article
                className={`question-maintenance-item ${selected === item.id ? 'selected' : ''}`}
                key={item.id}
              >
                <div>
                  <strong>
                    修订 #{item.sequence} · {item.title || '未命名题目'}
                  </strong>
                  <small>
                    {origins[item.origin]} · {localDate(item.createdAt)}
                  </small>
                  <p>{item.reason || '未填写修改原因'}</p>
                  <small>
                    变更：
                    {item.changedFields.map(questionRevisionFieldLabel).join('、') ||
                      '保留初始内容'}
                  </small>
                </div>
                <button
                  className="button"
                  type="button"
                  disabled={disabled}
                  onClick={() => setSelected(item.id)}
                >
                  {selected === item.id ? '正在查看' : '查看差异'}
                </button>
              </article>
            ))}
          </div>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={list.data.total}
            onPage={setPage}
            onPageSize={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            label="修订历史"
          />
        </>
      )}
      {selected && (
        <div className="question-revision-detail form-stack" aria-label="所选修订详情">
          {detail.loading || (detail.dataUrl !== detailUrl && !detail.error) ? (
            <Loading text="正在读取修订内容…" />
          ) : detail.error ? (
            <ErrorNotice message={detail.error} retry={detail.refresh} />
          ) : (
            detail.data && (
              <>
                <div className="question-maintenance-heading">
                  <h3>修订 #{detail.data.sequence} 与当前原题对照</h3>
                  <div className="question-maintenance-actions">
                    <button
                      className="button"
                      type="button"
                      disabled={disabled}
                      onClick={() => onLoad(detail.data!)}
                    >
                      载入此版本到编辑器
                    </button>
                    <button
                      className="button primary"
                      type="button"
                      disabled={disabled}
                      onClick={() => onRestore(detail.data!)}
                    >
                      恢复此版本并保存
                    </button>
                  </div>
                </div>
                {!detail.data.diff.length ? (
                  <p className="muted">该修订与当前已保存的题目内容相同。</p>
                ) : (
                  detail.data.diff.map((item) => (
                    <RevisionDifference key={detail.data!.id + ':' + item.field} {...item} />
                  ))
                )}
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
