import { useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type {
  LearningResetSelection,
  ScopedResetPreview,
} from '../../../shared/models/maintenance';
import type { PaperListPage } from '../../../shared/practice/paper-list';
import { ApiError, idPath, send, useResource, useDebounced } from '../../shared/lib/api';
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Pagination,
  SearchBox,
  useApp,
} from '../../shared/ui/components';
import './maintenance.css';

function PaperScopePicker({
  value,
  onChange,
  disabled,
}: {
  value?: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10),
    query = useDebounced(search, 250);
  const resource = useResource<PaperListPage>(
    `/api/papers/page?archived=true&page=${page}&pageSize=${pageSize}&search=${encodeURIComponent(query)}`,
  );
  const chosen = useResource<{ title: string }>(
    value ? `/api/papers/${idPath(value)}/metadata` : null,
  );
  return (
    <div className="maintenance-paper-picker">
      <SearchBox
        value={search}
        onChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        placeholder="搜索要重置的题集"
      />
      {chosen.data && <p className="muted">已选：{chosen.data.title}</p>}
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.refresh} />
      ) : (
        <>
          <div className="maintenance-paper-options">
            {resource.data?.items.map((paper) => (
              <label key={paper.id}>
                <input
                  type="radio"
                  name="reset-paper"
                  disabled={disabled}
                  checked={value === paper.id}
                  onChange={() => onChange(paper.id)}
                />
                <span>
                  {paper.title}
                  {paper.archived ? ' · 已归档' : ''}
                </span>
              </label>
            ))}
            {!resource.data?.items.length && <p className="muted">没有找到题集。</p>}
          </div>
          {resource.data && (
            <Pagination
              page={resource.data.page}
              pageSize={resource.data.pageSize}
              total={resource.data.total}
              onPage={setPage}
              onPageSize={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              label="重置范围题集"
            />
          )}
        </>
      )}
    </div>
  );
}

/** Both entry points share the same scope, preview and confirmation behavior. */
export function LearningReset({
  paperId,
  onDone,
  onClose,
}: { paperId?: string; onDone?: () => void; onClose?: () => void } = {}) {
  const { reload, toast } = useApp(),
    [selection, setSelection] = useState<LearningResetSelection>({
      scope: paperId ? 'paper' : 'all',
      ...(paperId ? { paperId } : {}),
      mode: 'progress',
    });
  const [done, setDone] = useState(false);
  const [preview, setPreview] = useState<ScopedResetPreview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    pending = useRef(false);
  const change = (next: LearningResetSelection) => {
    setSelection(next);
    setPreview(null);
    setConfirmed(false);
    setError('');
    setDone(false);
  };
  const inspect = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setDone(false);
    setConfirmed(false);
    setPreview(null);
    try {
      setPreview(
        await send<ScopedResetPreview>('/api/maintenance/reset-preview', 'POST', selection),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const apply = async () => {
    if (pending.current || !preview || !confirmed) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await send('/api/maintenance/reset', 'POST', {
        selection: preview.selection,
        fingerprint: preview.fingerprint,
        confirmed: true,
      });
      setPreview(null);
      setConfirmed(false);
      setDone(true);
      toast('已按所选范围重置学习记录');
      reload();
      onDone?.();
    } catch (reason) {
      setError((reason as Error).message);
      setConfirmed(false);
      if (reason instanceof ApiError && reason.status === 409) {
        setPreview(null);
        setConfirmed(false);
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const content = (
    <>
      <p className="muted">
        清理旧历史保留累计学习情况；重置会清除所选范围的学习证据。题目、题集和学习资料始终保留。
      </p>
      <fieldset disabled={busy} className="maintenance-fields">
        <div className="form-grid">
          {!paperId && (
            <Field label="重置范围">
              <select
                value={selection.scope}
                onChange={(e) =>
                  change({
                    scope: e.target.value as LearningResetSelection['scope'],
                    mode: selection.mode,
                  })
                }
              >
                <option value="all">全部学习记录</option>
                <option value="paper">指定题集</option>
                <option value="quick">随机与单题自测</option>
              </select>
            </Field>
          )}
          <Field label="重置级别">
            <select
              value={selection.mode}
              onChange={(e) =>
                change({ ...selection, mode: e.target.value as LearningResetSelection['mode'] })
              }
            >
              <option value="progress">仅重置学习进度</option>
              <option value="complete">
                {selection.scope === 'all' ? '彻底清空学习数据' : '清空本范围作答和进度'}
              </option>
            </select>
          </Field>
        </div>
        {selection.scope === 'paper' && !paperId && (
          <PaperScopePicker
            value={selection.paperId}
            disabled={busy}
            onChange={(id) => change({ ...selection, paperId: id })}
          />
        )}
      </fieldset>
      <div className="notice info">
        {selection.scope === 'all'
          ? selection.mode === 'complete'
            ? '将清空全部作答、草稿、统计、错题、复习、笔记和收藏。附件、组题、资料与AI工作台编辑草稿及系统配置保留。'
            : '清空掌握程度、错题统计与复习安排，保留笔记、收藏、历史卷面与作答草稿。'
          : '只重置本来源产生的学习记录。共享题目的笔记、收藏、手动掌握、无法区分来源的日期及其他题集记录保留；复习卡根据剩余来源重新计算。'}
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="button danger-text"
          disabled={busy || (selection.scope === 'paper' && !selection.paperId)}
          onClick={() => void inspect()}
        >
          <RotateCcw size={16} />
          {busy ? '正在处理…' : '预览重置范围'}
        </button>
        {onClose && (
          <button className="button" disabled={busy} onClick={onClose}>
            取消
          </button>
        )}
      </div>
      {error && <ErrorNotice message={error} />}{' '}
      {done && (
        <p className="notice success" role="status">
          学习进度已重置，已按所选范围保留内容和其他记录。
        </p>
      )}
    </>
  );
  const confirmation = preview && (
    <Modal
      title="确认重置学习进度"
      onClose={() => {
        if (!busy) {
          setPreview(null);
          setConfirmed(false);
        }
      }}
    >
      <p>
        <strong>{preview.title}</strong> ·{' '}
        {preview.selection.mode === 'complete' ? '清空学习记录' : '仅重置进度'}
      </p>
      <ul className="maintenance-impact">
        <li>
          {preview.counts.results}份学习结果、{preview.counts.reviews}条复习记录、
          {preview.counts.reviewEvents}条自适应复习事件
        </li>
        <li>
          {preview.counts.states}份原题与{preview.counts.partStates}份小题状态、
          {preview.counts.planProgress}条计划完成记录
        </li>
        <li>
          {preview.counts.focusSessions}份专注复习；{preview.counts.reviewCards}
          张复习卡将重新计算或清空
        </li>
        {preview.selection.mode === 'complete' ? (
          <li>
            删除{preview.removed.attempts}份已交答卷、{preview.removed.drafts}份作答草稿、
            {preview.removed.questionHistory}份单题详细回答及{preview.removed.aiGrades}
            条AI作答评价；清空{preview.removed.study}
            份包含笔记与收藏的状态
          </li>
        ) : (
          <li>
            保留{preview.retained.attempts}份历史答卷、{preview.retained.drafts}
            份草稿；旧单题回答标为重置前记录，不再计入当前统计
          </li>
        )}
      </ul>
      {preview.retained.sharedState && (
        <p className="notice info">
          共享题目的笔记、收藏和手动掌握继续保留。混合来源的{preview.retained.mixedFocus}
          份专注复习仅处理对应条目，保留其他来源；进行中的相关专注复习会结束。
        </p>
      )}
      <p className="muted">此操作无法从当前库撤销。可先取消，在“数据维护与备份”导出完整备份。</p>
      {error && <ErrorNotice message={error} />}
      <label className="check-row">
        <input
          type="checkbox"
          disabled={busy}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我确认按以上范围重置
      </label>
      <div className="form-actions">
        <button className="button" disabled={busy} onClick={() => setPreview(null)}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || !confirmed}
          onClick={() => void apply()}
        >
          {busy ? '正在重置…' : '确认重置学习进度'}
        </button>
      </div>
    </Modal>
  );
  return (
    <>
      {paperId ? (
        !preview && (
          <Modal title="重置本集学习记录" onClose={() => !busy && onClose?.()}>
            {content}
          </Modal>
        )
      ) : (
        <section className="card settings-section ui-stack" aria-label="分级重置学习进度">
          <h2>分级重置学习进度</h2>
          {content}
        </section>
      )}
      {confirmation}
    </>
  );
}
