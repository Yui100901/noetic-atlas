import { useEffect, useState } from 'react';
import { BookOpen, Clock3, Play } from 'lucide-react';
import type { FocusSummary, FocusView } from '../../../shared/models/focus-review';
import type { Paged } from '../../../shared/utils/pagination';
import { idPath, localDate, qs, request, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, Modal, Pagination } from '../../shared/ui/components';
import './focus-review.css';

const urlFor = (paperId?: string) =>
  `/api/focus-sessions?${qs({ paperId, page: 1, pageSize: 10, status: 'in_progress' })}`;
export function FocusLauncher({
  paperId,
  practiceKind,
  filters = {},
  open: controlled,
  onOpenChange,
  hideTrigger = false,
}: {
  paperId?: string;
  practiceKind?: string;
  filters?: { domainId?: string; categoryId?: string; direction?: string; kind?: string };
  open?: boolean;
  onOpenChange?: (value: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [ownOpen, setOwnOpen] = useState(false),
    open = controlled ?? ownOpen;
  const change = (value: boolean) => {
    setOwnOpen(value);
    onOpenChange?.(value);
  };
  const [scope, setScope] = useState<'due' | 'all'>('due'),
    [count, setCount] = useState(20),
    [direction, setDirection] = useState(''),
    [drafts, setDrafts] = useState<FocusSummary[]>([]),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void request<Paged<FocusSummary>>(urlFor(paperId), { signal: controller.signal })
      .then((data) => setDrafts(data.items))
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, paperId]);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const session = await send<FocusView>('/api/focus-sessions', 'POST', {
        ...(paperId ? { paperId } : {}),
        scope: paperId ? scope : 'due',
        count,
        ...filters,
        ...(direction ? { direction } : {}),
      });
      change(false);
      window.location.hash = `#/focus-review/${idPath(session.id)}`;
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!hideTrigger && (
        <button type="button" className="button primary" onClick={() => change(true)}>
          <Play size={16} />
          专注复习
        </button>
      )}
      {open && (
        <Modal
          title="开始专注复习"
          onClose={() => {
            if (!busy) change(false);
          }}
        >
          <div className="form-stack">
            <p className="muted">
              逐题回忆、核对答案、评级并继续；实际回答和心答自评分别记录。复习使用当前已发布原题。
            </p>
            {loading ? (
              <Loading text="正在读取未完成会话…" />
            ) : (
              drafts.length > 0 && (
                <section className="focus-resume">
                  <h3>
                    <Clock3 size={16} />
                    继续上次复习
                  </h3>
                  {drafts.map((item) => (
                    <a
                      className="button focus-resume-item"
                      key={item.id}
                      href={`#/focus-review/${idPath(item.id)}`}
                    >
                      <span>
                        已复习 {item.rated}/{item.total} 项 · {localDate(item.updatedAt)}
                      </span>
                      <span>继续 →</span>
                    </a>
                  ))}
                </section>
              )
            )}
            {paperId && (
              <Field label="复习范围">
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as 'due' | 'all')}
                >
                  <option value="due">仅当前题集到期任务</option>
                  <option value="all">从当前题集全部题目随机选择</option>
                </select>
              </Field>
            )}
            <Field label="本次复习任务数" hint="每个小题或词卡方向各算一个任务，每次最多200项。">
              <input
                type="number"
                min={1}
                max={200}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </Field>
            {paperId && ['vocabulary', 'concept'].includes(practiceKind || '') && (
              <Field label="复习方向">
                <select value={direction} onChange={(event) => setDirection(event.target.value)}>
                  <option value="">沿用到期任务／默认顺向</option>
                  <option value="word_to_meaning">顺向：看词语或概念想含义</option>
                  <option value="meaning_to_word">逆向：看释义或描述想名称</option>
                </select>
              </Field>
            )}
            {error && <ErrorNotice message={error} />}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => change(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy || loading || !Number.isInteger(count) || count < 1 || count > 200}
                onClick={() => void start()}
              >
                {busy ? '正在准备…' : drafts.length ? '开始新的复习' : '开始本次复习'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

export function FocusHistory({ paperId }: { paperId?: string }) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(10);
  const resource = useResource<Paged<FocusSummary>>(
    open ? `/api/focus-sessions?${qs({ paperId, page, pageSize })}` : null,
  );
  return (
    <details className="card focus-history" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <BookOpen size={16} />
        专注复习记录
      </summary>
      {open && (
        <div className="focus-history-body">
          {resource.loading ? (
            <Loading />
          ) : resource.error ? (
            <ErrorNotice message={resource.error} retry={resource.refresh} />
          ) : resource.data?.items.length ? (
            <>
              {resource.data.items.map((item) => (
                <a
                  className="focus-history-row"
                  key={item.id}
                  href={`#/focus-review/${idPath(item.id)}`}
                >
                  <div>
                    <strong>
                      {item.status === 'in_progress' ? '继续复习' : '查看总结'} · {item.rated}/
                      {item.total} 项
                    </strong>
                    <p>
                      {localDate(item.updatedAt)} · 实际作答 {item.written} 项 · 心答自评{' '}
                      {item.mental} 项 · 用时 {item.elapsedSeconds} 秒
                    </p>
                  </div>
                  <span>→</span>
                </a>
              ))}
              <Pagination
                page={page}
                pageSize={pageSize}
                total={resource.data.total}
                onPage={setPage}
                onPageSize={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
                label="专注复习记录"
              />
            </>
          ) : (
            <p className="muted">开始专注复习后，进度和总结保存在这里。</p>
          )}
        </div>
      )}
    </details>
  );
}
