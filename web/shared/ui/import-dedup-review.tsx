import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, CopyCheck, SearchCheck } from 'lucide-react';
import type {
  ImportDedupCandidate,
  ImportDedupDecision,
  ImportDedupItem,
  ImportDedupPreview,
} from '../../../shared/models/import-dedup';
import type { QuestionInput } from '../../../shared/models/types';
import { typeLabels } from '../../../shared/models/types';
import {
  questionRevisionContent,
  questionRevisionDifferences,
} from '../../../shared/questions/question-revisions';
import { idPath, request } from '../lib/api';
import { usePagination } from '../lib/pagination';
import {
  bulkImportDecision,
  selectImportDecision,
  unresolvedImportItems,
} from '../lib/import-review-state';
import { ErrorNotice, Loading, Pagination, SearchBox } from './components';
import { QuestionContentPreview } from '../../features/questions/question-content-preview';
import {
  questionRevisionFieldLabel,
  questionRevisionFieldText,
} from '../../features/questions/question-maintenance-state';
import './import-dedup-review.css';

const actionLabels = { replace: '采用导入内容覆盖', keep: '保留原题', both: '保留两者' };
type IncomingReader = (index: number, signal?: AbortSignal) => Promise<QuestionInput>;

function ImportComparison({
  item,
  candidate,
  readIncoming,
}: {
  item: ImportDedupItem;
  candidate?: ImportDedupCandidate;
  readIncoming: IncomingReader;
}) {
  const [detail, setDetail] = useState<{
    incoming: QuestionInput;
    existing?: QuestionInput;
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError('');
    const incoming = readIncoming(item.index, controller.signal);
    const existing = !candidate
      ? Promise.resolve(undefined)
      : candidate.incomingIndex !== undefined
        ? readIncoming(candidate.incomingIndex, controller.signal)
        : request<QuestionInput>(`/api/questions/${idPath(candidate.id)}`, {
            signal: controller.signal,
          });
    void Promise.all([incoming, existing])
      .then(([incoming, existing]) => {
        if (!controller.signal.aborted) setDetail({ incoming, existing });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    return () => controller.abort();
  }, [item.index, candidate?.id, readIncoming]);
  if (error) return <ErrorNotice message={error} />;
  if (!detail) return <Loading text="正在加载题目差异…" />;
  const differences = detail.existing
    ? questionRevisionDifferences(
        questionRevisionContent(detail.existing),
        questionRevisionContent(detail.incoming),
      )
    : [];
  return (
    <div className="import-comparison">
      {detail.existing && (
        <details className="import-field-differences" open>
          <summary>字段差异（{differences.length}项）</summary>
          {differences.length ? (
            differences.map((diff) => (
              <details key={diff.field}>
                <summary>{questionRevisionFieldLabel(diff.field)}</summary>
                <div className="import-compare-grid">
                  <div>
                    <strong>原题</strong>
                    <pre>{questionRevisionFieldText(diff.field, diff.before) || '空'}</pre>
                  </div>
                  <div>
                    <strong>导入题</strong>
                    <pre>{questionRevisionFieldText(diff.field, diff.after) || '空'}</pre>
                  </div>
                </div>
              </details>
            ))
          ) : (
            <p className="muted">题目内容一致，请结合来源和结构核对。</p>
          )}
        </details>
      )}
      <div className="import-compare-grid">
        {detail.existing && (
          <section className="import-compare-pane">
            <h4>
              {candidate?.incomingIndex !== undefined ? '本批另一题' : '原题'} ·{' '}
              {detail.existing.title}
            </h4>
            <QuestionContentPreview question={detail.existing} />
          </section>
        )}
        <section className="import-compare-pane">
          <h4>导入题 · {detail.incoming.title}</h4>
          <QuestionContentPreview question={detail.incoming} />
        </section>
      </div>
    </div>
  );
}

/** Shared package/AI review: metadata is paged; full bodies are fetched only
 * for the currently opened comparison. Choices never mutate the bank here. */
export function ImportDedupReview({
  preview,
  decisions,
  onChange,
  readIncoming,
  disabled = false,
}: {
  preview: ImportDedupPreview;
  decisions: ImportDedupDecision[];
  onChange: (value: ImportDedupDecision[]) => void;
  readIncoming: IncomingReader;
  disabled?: boolean;
}) {
  const [kind, setKind] = useState<'similar' | 'exact' | 'new'>(
    preview.counts.similar ? 'similar' : preview.counts.exact ? 'exact' : 'new',
  );
  const [search, setSearch] = useState(''),
    [onlyPending, setOnlyPending] = useState(false);
  const [expanded, setExpanded] = useState(''),
    [targets, setTargets] = useState<Record<string, string>>({});
  const initial = useRef(preview.fingerprint);
  useEffect(() => {
    if (initial.current === preview.fingerprint) return;
    initial.current = preview.fingerprint;
    setKind(preview.counts.similar ? 'similar' : preview.counts.exact ? 'exact' : 'new');
    setExpanded('');
    setTargets({});
    setSearch('');
  }, [preview.fingerprint]);
  const decisionMap = useMemo(
    () => new Map(decisions.map((item) => [item.key, item])),
    [decisions],
  );
  const pending = useMemo(() => unresolvedImportItems(preview, decisions), [preview, decisions]);
  const pendingKeys = useMemo(() => new Set(pending.map((item) => item.key)), [pending]);
  const items = useMemo(
    () =>
      preview.items.filter(
        (item) =>
          item.kind === kind &&
          (!onlyPending || kind !== 'similar' || pendingKeys.has(item.key)) &&
          `${item.title} ${item.index + 1}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase()),
      ),
    [preview, kind, onlyPending, pendingKeys, search],
  );
  const paging = usePagination(items, `${preview.fingerprint}:${kind}:${onlyPending}:${search}`);
  return (
    <section className="import-dedup-review form-stack" aria-label="导入查重结果">
      <header className="import-dedup-heading">
        <SearchCheck size={21} />
        <div>
          <h3>题目查重</h3>
          <p className="muted">
            共{preview.total.toLocaleString()}题；完全重复自动复用，相似题由你决定。
          </p>
        </div>
      </header>
      <div className="import-dedup-tabs" role="tablist" aria-label="查重结果分类">
        {(['similar', 'exact', 'new'] as const).map((value) => (
          <button
            type="button"
            role="tab"
            aria-selected={kind === value}
            className={kind === value ? 'active' : ''}
            key={value}
            onClick={() => {
              setKind(value);
              setExpanded('');
            }}
          >
            {{ similar: '相似待核对', exact: '完全重复', new: '新增题目' }[value]}
            <span>{preview.counts[value].toLocaleString()}</span>
          </button>
        ))}
      </div>
      {preview.counts.similar > 0 && (
        <p className={`notice ${pending.length ? 'warning' : 'success'}`} role="status">
          {pending.length
            ? `还有${pending.length}道相似题未选择处理方式。`
            : '相似题已全部选择处理方式。'}
          覆盖保留原题号、学习情况及旧答卷，并保存内容修订。
        </p>
      )}
      <div className="import-dedup-toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="搜索本次导入题目" />
        {kind === 'similar' && (
          <label className="check-row">
            <input
              type="checkbox"
              checked={onlyPending}
              onChange={(event) => setOnlyPending(event.target.checked)}
            />
            只看未处理
          </label>
        )}
      </div>
      {kind === 'similar' && pending.length > 0 && (
        <div className="action-row import-dedup-bulk">
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() => onChange(bulkImportDecision(preview, decisions, 'both'))}
          >
            未处理项全部保留两者
          </button>
          <button
            type="button"
            className="button"
            disabled={disabled}
            onClick={() =>
              onChange(
                bulkImportDecision(
                  preview,
                  decisions,
                  'keep',
                  paging.items.map((item) => item.key),
                ),
              )
            }
          >
            本页未处理项保留最相近原题
          </button>
        </div>
      )}
      {kind === 'exact' && (
        <p className="muted">
          完全重复只保留一个对象，题集和题目链接将引用保留题号；原题的审核、归档和学习状态保持。
        </p>
      )}
      {paging.items.length ? (
        <div className="import-dedup-items">
          {paging.items.map((item) => {
            const decision = decisionMap.get(item.key),
              selectedId = targets[item.key] || decision?.targetId || item.candidates[0]?.id;
            const candidate = item.candidates.find((value) => value.id === selectedId);
            const open = expanded === item.key;
            return (
              <article className={`import-dedup-item import-dedup-${item.kind}`} key={item.key}>
                <div className="import-dedup-row">
                  <div>
                    <span className="muted">
                      第{item.index + 1}题 · {typeLabels[item.type]}
                    </span>
                    <h4>{item.title}</h4>
                    {item.kind === 'exact' && (
                      <p className="muted">
                        <CopyCheck size={14} />
                        {item.duplicateOf
                          ? '与本批另一题完全重复'
                          : `复用题号：${item.targetId || '已有题目'}`}
                      </p>
                    )}
                    {decision && (
                      <span className="badge">已选：{actionLabels[decision.action]}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="button"
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? '' : item.key)}
                  >
                    {open ? '收起' : item.kind === 'similar' ? '查看差异' : '查看题目'}
                    {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                </div>
                {item.kind === 'similar' && (
                  <div className="import-dedup-choices">
                    <label>
                      对比对象
                      <select
                        disabled={disabled}
                        value={selectedId || ''}
                        onChange={(event) => {
                          setTargets((values) => ({ ...values, [item.key]: event.target.value }));
                          if (decision?.action !== 'both')
                            onChange(selectImportDecision(decisions, item, null));
                        }}
                      >
                        {item.candidates.map((value) => (
                          <option key={value.id} value={value.id}>
                            {value.incomingIndex !== undefined
                              ? `本批第${value.incomingIndex + 1}题`
                              : value.id}{' '}
                            · {value.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    {candidate && <p className="muted">{candidate.reason}</p>}
                    <div className="action-row">
                      {(['keep', 'both', 'replace'] as const).map((action) => (
                        <button
                          type="button"
                          key={action}
                          disabled={disabled || (action !== 'both' && !candidate)}
                          className={`button ${decision?.action === action ? 'primary' : ''} ${action === 'replace' ? 'import-replace-action' : ''}`}
                          aria-pressed={decision?.action === action}
                          onClick={() =>
                            onChange(selectImportDecision(decisions, item, action, selectedId))
                          }
                        >
                          {actionLabels[action]}
                        </button>
                      ))}
                      {decision && (
                        <button
                          type="button"
                          className="button"
                          disabled={disabled}
                          onClick={() => onChange(selectImportDecision(decisions, item, null))}
                        >
                          撤回选择
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {open && (
                  <ImportComparison
                    key={`${preview.fingerprint}:${item.key}:${candidate?.id || ''}`}
                    item={item}
                    candidate={item.kind === 'similar' ? candidate : undefined}
                    readIncoming={readIncoming}
                  />
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="muted">没有符合条件的题目。</p>
      )}
      <Pagination {...paging} label="导入查重题目" />
      <details className="import-dedup-scope">
        <summary>查重范围与处理说明</summary>
        <p>
          完全重复按学习内容比较，ID、时间和分类来源差异不单独产生一张新题；答案、判题要求或结构不同会留给你核对。近似匹配提供有限候选，不代表覆盖所有语义近似题。
        </p>
        <p>
          已检查索引{preview.metrics.indexed.toLocaleString()}项，详细比较
          {preview.metrics.compared.toLocaleString()}次；每题近似候选上限
          {preview.metrics.candidateLimit}。新增题进入待审核，覆盖操作须由你明确选择。
        </p>
      </details>
    </section>
  );
}
