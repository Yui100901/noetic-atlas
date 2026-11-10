import { useRef, useState } from 'react';
import { Activity, RefreshCw, Trash2 } from 'lucide-react';
import {
  CLEANUP_KINDS,
  CLEANUP_LABELS,
  type CleanupSelection,
  type CleanupPreview,
  type DataHealth,
} from '../../../shared/models/maintenance';
import { ApiError, localDate, request, send, useResource } from '../../shared/lib/api';
import { ErrorNotice, Field, Loading, Modal, useApp } from '../../shared/ui/components';
import { LearningReset } from './learning-reset';
import './maintenance.css';

const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(2)} MiB`;
export type MaintenanceView = 'health' | 'cleanup' | 'reset' | 'all';
export function DataMaintenance({ view = 'all' }: { view?: MaintenanceView }) {
  const showHealth = view === 'health' || view === 'all';
  const showCleanup = view === 'cleanup' || view === 'all';
  const { toast, reload } = useApp(),
    health = useResource<DataHealth>(showHealth ? '/api/maintenance/health' : null);
  const [checked, setChecked] = useState<DataHealth | null>(null),
    [selection, setSelection] = useState<CleanupSelection>({
      kinds: ['unused_assets'],
      olderThanDays: 30,
    }),
    [preview, setPreview] = useState<CleanupPreview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [action, setAction] = useState<'compact' | 'reindex' | null>(null),
    pending = useRef(false);
  const data = checked || health.data;
  const refresh = () => {
    setChecked(null);
    health.refresh();
  };
  const task = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
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
  const change = (next: CleanupSelection) => {
    setSelection(next);
    setPreview(null);
    setConfirmed(false);
    setError('');
  };
  return (
    <div className="maintenance-stack">
      {showHealth && (
        <section className="card settings-section ui-stack">
          <header className="maintenance-heading">
            <div>
              <h2>
                <Activity size={20} />
                数据健康
              </h2>
              <p className="muted">先检查与预览，再决定维护范围。</p>
            </div>
            <div className="action-row">
              <a className="button" href="#/settings?tab=backup&sub=migration">
                导出或恢复备份
              </a>
              <button className="button" disabled={busy || health.loading} onClick={refresh}>
                <RefreshCw size={15} />
                刷新
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    setChecked(await request<DataHealth>('/api/maintenance/health?integrity=true'));
                  })
                }
              >
                检查数据库
              </button>
            </div>
          </header>
          {health.loading && !data ? (
            <Loading />
          ) : data ? (
            <>
              <div className="maintenance-metrics">
                {[
                  ['题目', data.counts.questions],
                  ['题集', data.counts.papers],
                  ['学习资料', data.counts.documents],
                  ['作答记录', data.counts.attempts],
                  ['数据库', bytes(data.storage.databaseBytes)],
                  ['可整理空间', bytes(data.storage.freeBytes)],
                ].map(([name, value]) => (
                  <div key={name}>
                    <span>{name}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <p className="muted">
                最近检查 {localDate(data.checkedAt)}
                {data.storage.integrity
                  ? ` · 一致性${data.storage.integrity.every((v) => v === 'ok') ? '正常' : '存在异常'}`
                  : ''}{' '}
                · 未引用文件{data.unusedAssets}份，{bytes(data.unusedAssetBytes)}
              </p>
              {data.issues.map((issue, index) => (
                <p
                  key={index}
                  className={`notice ${issue.level === 'warning' ? 'warning' : 'info'}`}
                >
                  {issue.message}
                  {issue.href && <a href={issue.href}>前往查看</a>}
                </p>
              ))}
              {!data.issues.length && (
                <p className="notice success">未发现附件引用或空间方面的维护提示。</p>
              )}
              <details>
                <summary>高级维护与最近操作</summary>
                <p className="muted">
                  索引重建用于修复搜索和引用索引；空间整理用于回收清理后的空闲页。维护期间请等待操作完成。
                </p>
                <div className="form-actions">
                  <button className="button" disabled={busy} onClick={() => setAction('reindex')}>
                    重建搜索与引用索引
                  </button>
                  <button className="button" disabled={busy} onClick={() => setAction('compact')}>
                    整理数据库空间
                  </button>
                </div>
                {data.operations.length ? (
                  <ol>
                    {data.operations.map((op, i) => (
                      <li key={i}>
                        {localDate(op.at)} · {op.summary}
                        {op.count ? `（${op.count}项）` : ''}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="muted">暂无维护操作。</p>
                )}
              </details>
            </>
          ) : health.error ? (
            <ErrorNotice message={health.error} retry={refresh} />
          ) : null}
        </section>
      )}
      {showCleanup && (
        <section className="card settings-section ui-stack">
          <h2>清理旧数据</h2>
          <p className="muted">
            清理历史卷面与单题详细回答不会清空累计统计、错题、笔记或收藏。正在计时和考试中的草稿、教材任务关联记录及仍被引用的文件会保留。
          </p>
          <fieldset className="maintenance-fields" disabled={busy}>
            <Field label="仅处理早于多少天的记录">
              <input
                type="number"
                min={1}
                max={36500}
                value={selection.olderThanDays}
                onChange={(e) => change({ ...selection, olderThanDays: Number(e.target.value) })}
              />
            </Field>
            <div className="maintenance-choices">
              {CLEANUP_KINDS.map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={selection.kinds.includes(kind)}
                    onChange={(e) =>
                      change({
                        ...selection,
                        kinds: e.target.checked
                          ? [...selection.kinds, kind]
                          : selection.kinds.filter((k) => k !== kind),
                      })
                    }
                  />
                  <span>{CLEANUP_LABELS[kind]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="muted">
            组题、资料与AI辅助草稿可能包含尚未发布的内容，仅在勾选后处理。文件会检查原题、资料、原文版本、历史卷面和教材候选题等全部引用。
          </p>
          <div className="form-actions">
            <button
              className="button"
              disabled={
                busy ||
                !selection.kinds.length ||
                !Number.isInteger(selection.olderThanDays) ||
                selection.olderThanDays < 1 ||
                selection.olderThanDays > 36500
              }
              onClick={() =>
                void task(async () => {
                  setConfirmed(false);
                  setPreview(
                    await send<CleanupPreview>(
                      '/api/maintenance/cleanup-preview',
                      'POST',
                      selection,
                    ),
                  );
                })
              }
            >
              <Trash2 size={16} />
              预览清理范围
            </button>
          </div>
        </section>
      )}
      {error && <ErrorNotice message={error} />}
      {(view === 'reset' || view === 'all') && <LearningReset onDone={refresh} />}
      {preview && (
        <Modal
          title="确认清理旧数据"
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <p>
            截止 {localDate(preview.cutoff)}，本次共{preview.total}项，记录体积约
            {bytes(preview.logicalBytes)}。实际文件大小在整理数据库空间后变化。
          </p>
          <div className="maintenance-preview">
            {preview.items.map((item) => (
              <details key={item.kind}>
                <summary>
                  {CLEANUP_LABELS[item.kind]}：{item.count}项 · {bytes(item.bytes)}
                </summary>
                <ul>
                  {item.samples.map((sample) => (
                    <li key={sample.id}>
                      {sample.title} · {localDate(sample.date)}
                    </li>
                  ))}
                </ul>
                {item.count > item.samples.length && (
                  <small>仅显示前{item.samples.length}条示例。</small>
                )}
              </details>
            ))}
          </div>
          {preview.protectedAiRuns > 0 && (
            <p className="notice info">
              另有{preview.protectedAiRuns}条AI历史属于教材任务或反馈证据，已排除。
            </p>
          )}
          <p className="muted">清理不可直接撤销，可先取消并导出完整备份。</p>
          {error && <ErrorNotice message={error} />}
          <label className="check-row">
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我确认清理以上记录
          </label>
          <div className="form-actions">
            <button className="button" disabled={busy} onClick={() => setPreview(null)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy || !confirmed || !preview.total}
              onClick={() =>
                void task(async () => {
                  await send('/api/maintenance/cleanup', 'POST', {
                    selection: preview.selection,
                    fingerprint: preview.fingerprint,
                    confirmed: true,
                  });
                  setPreview(null);
                  setConfirmed(false);
                  toast('已按预览清理，学习进度继续保留');
                  refresh();
                  reload();
                })
              }
            >
              {busy ? '正在清理…' : '确认清理'}
            </button>
          </div>
        </Modal>
      )}
      {action && (
        <Modal
          title={action === 'compact' ? '整理数据库空间' : '重建搜索与引用索引'}
          onClose={() => !busy && setAction(null)}
        >
          <p>
            {action === 'compact'
              ? '整理会回收空闲页，题目、配置与学习记录保持原样。大型数据库可能需要一些时间。'
              : '将从原始数据重建搜索、内容读取和附件引用索引。数据规模较大时请等待完成。'}
          </p>
          {error && <ErrorNotice message={error} />}
          <div className="form-actions">
            <button className="button" disabled={busy} onClick={() => setAction(null)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void task(async () => {
                  await send(`/api/maintenance/${action}`, 'POST', { confirmed: true });
                  setAction(null);
                  toast('维护已完成');
                  refresh();
                })
              }
            >
              {busy ? '正在维护…' : '确认执行'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
