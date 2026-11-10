import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCheck,
  Download,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { saveGeneratedFile } from '@platform';
import { base64ToBytes } from '../../../shared/assets/assets';
import {
  terminalTask,
  type BackgroundTask,
  type TaskResult,
  type TaskStatus,
} from '../../../shared/tasks/tasks';
import { usePagination } from '../../shared/lib/pagination';
import { Empty, ErrorNotice, PageHeader, Pagination } from '../../shared/ui/components';
import {
  cancelTask,
  getTasks,
  isTasksEnabled,
  markTaskRead,
  refreshTasks,
  removeTask,
  retryTask,
  subscribeTasks,
  downloadTaskFile,
  taskResult,
} from './client';
import './task-center.css';

const emptyTasks: BackgroundTask[] = [];
const statusLabels: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '处理中',
  committing: '正在保存',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
type Filter = 'all' | 'active' | 'unread' | TaskStatus;
type ResultSummary = { label: string; value: string };
const useTasks = () => useSyncExternalStore(subscribeTasks, getTasks, () => emptyTasks);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Result bodies may contain original materials or large packages. Only selected
// metadata is displayed, never a generic JSON dump or the saved task input.
function displayText(value: unknown, limit = 400): string {
  return typeof value === 'string'
    ? value
        .replace(/\bsk-[a-z\d_-]+/gi, '[已隐藏密钥]')
        .replace(/\bBearer\s+[a-z\d._~+\/-]+/gi, 'Bearer [已隐藏]')
        .slice(0, limit)
    : '';
}

function errorMessage(error: unknown) {
  return displayText(error instanceof Error ? error.message : '操作失败，请稍后重试。', 1200);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? '时间未知'
    : date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}

type DownloadFile = { filename: string; mime: string; byteLength: number; base64?: string };

function base64Size(value: string) {
  return Math.max(
    0,
    Math.floor((value.length * 3) / 4) - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0),
  );
}

function fileInfo(result: TaskResult): DownloadFile | undefined {
  if (result.binaryBase64 || result.binaryByteLength !== undefined) {
    const fallback = result.contentType.includes('sqlite')
      ? '认知星图-数据迁移.sqlite'
      : result.contentType.includes('zip')
        ? '认知星图-任务结果.zip'
        : '认知星图-任务结果.bin';
    return {
      base64: result.binaryBase64,
      byteLength: result.binaryByteLength ?? base64Size(result.binaryBase64 || ''),
      filename: displayText(result.filename, 180) || fallback,
      mime: result.contentType || 'application/octet-stream',
    };
  }
  const value = result.json;
  if (isRecord(value) && typeof value.dataBase64 === 'string')
    return {
      base64: value.dataBase64,
      byteLength: base64Size(value.dataBase64),
      filename: displayText(value.filename, 180) || '认知星图-任务结果.zip',
      mime: displayText(value.mimeType, 100) || 'application/zip',
    };
  return undefined;
}

function summarizeResult(result: TaskResult): ResultSummary[] {
  const summary: ResultSummary[] = [];
  const file = fileInfo(result);
  if (file) {
    summary.push({ label: '文件', value: file.filename });
    const bytes = file.byteLength;
    summary.push({
      label: '大小',
      value:
        bytes >= 1024 * 1024
          ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
          : `${Math.ceil(bytes / 1024).toLocaleString()} KB`,
    });
  }
  if (!isRecord(result.json)) return summary;
  const root = result.json;
  const metadata = isRecord(root.summary) ? root.summary : root;
  const nested = isRecord(root.result) ? root.result : undefined;
  const title = displayText(nested?.title || root.title, 180);
  if (title) summary.push({ label: '名称', value: title });
  const countFields: [string, string][] = [
    ['questionCount', '题目'],
    ['domainCount', '领域'],
    ['fileCount', '文件数量'],
    ['createdCount', '新增'],
    ['updatedCount', '更新'],
    ['skippedCount', '跳过'],
    ['importedCount', '已导入'],
    ['completedCount', '已处理'],
    ['failedCount', '失败'],
  ];
  for (const [key, label] of countFields) {
    const value = metadata[key] ?? nested?.[key];
    if (typeof value === 'number' && Number.isFinite(value))
      summary.push({ label, value: value.toLocaleString() });
  }
  const questionIds = Array.isArray(root.questionIds)
    ? root.questionIds
    : Array.isArray(nested?.questionIds)
      ? nested.questionIds
      : undefined;
  if (questionIds && !summary.some((row) => row.label === '题目'))
    summary.push({ label: '题目', value: questionIds.length.toLocaleString() });
  const generated = Array.isArray(nested?.questions)
    ? nested.questions
    : Array.isArray(nested?.items)
      ? nested.items
      : undefined;
  if (generated && !summary.some((row) => row.label === '题目'))
    summary.push({ label: '结果条目', value: generated.length.toLocaleString() });
  if (isRecord(root.counts)) {
    // Import previews expose counts by entity; their content stays in the import page.
    for (const [key, label] of [
      ['questions', '题目'],
      ['papers', '题集'],
      ['materials', '资料'],
    ] as const) {
      const counts = root.counts[key];
      if (!isRecord(counts)) continue;
      const parts = [
        ['added', '新增'],
        ['reused', '复用'],
        ['remapped', '映射'],
        ['skipped', '跳过'],
      ] as const;
      const text = parts.flatMap(([field, name]) =>
        typeof counts[field] === 'number' && Number.isFinite(counts[field])
          ? [`${name} ${counts[field].toLocaleString()}`]
          : [],
      );
      if (text.length) summary.push({ label, value: text.join(' · ') });
    }
  }
  return summary.slice(0, 12);
}

function returnLink(task: BackgroundTask) {
  // A task is only allowed to return to a local application route.
  if (!/^#\/(?!\/)[^#\u0000-\u001f\u007f<>"\\]*$/u.test(task.returnTo)) return undefined;
  const questionMark = task.returnTo.indexOf('?');
  const path = questionMark < 0 ? task.returnTo : task.returnTo.slice(0, questionMark);
  if (path === '#/tasks') return undefined;
  const query = new URLSearchParams(questionMark < 0 ? '' : task.returnTo.slice(questionMark + 1));
  query.set('backgroundTask', task.id);
  return `${path}?${query.toString()}`;
}

export function TaskCenterPage() {
  const tasks = useTasks();
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  // Keep one result open so large export payloads do not accumulate in the page.
  const [result, setResult] = useState<{ id: string; value: TaskResult }>();
  const enabled = isTasksEnabled();
  const activeCount = tasks.filter((task) => !terminalTask(task)).length;
  const unreadCount = tasks.filter((task) => terminalTask(task) && !task.read).length;
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          filter === 'all' ||
          (filter === 'active'
            ? !terminalTask(task)
            : filter === 'unread'
              ? terminalTask(task) && !task.read
              : task.status === filter),
      ),
    [tasks, filter],
  );
  const pagination = usePagination(filtered, filter);

  async function refresh() {
    setRefreshing(true);
    setError('');
    try {
      await refreshTasks();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled]);

  async function action(id: string, work: () => Promise<unknown>) {
    setBusy(id);
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }

  async function viewResult(task: BackgroundTask) {
    if (result?.id === task.id) {
      setResult(undefined);
      return;
    }
    await action(task.id, async () => {
      const value = await taskResult(task.id);
      setResult({ id: task.id, value });
      if (!task.read) await markTaskRead(task.id);
    });
  }

  async function downloadResult(task: BackgroundTask) {
    await action(task.id, async () => {
      const value = result?.id === task.id ? result.value : await taskResult(task.id);
      const file = fileInfo(value);
      if (!file) throw new Error('该任务没有可下载文件，请返回原功能查看并使用结果。');
      if (file.base64 !== undefined)
        await saveGeneratedFile(file.filename, base64ToBytes(file.base64), file.mime);
      else await downloadTaskFile(task.id, file.filename, file.mime);
      if (!task.read) await markTaskRead(task.id);
    });
  }

  async function deleteTask(task: BackgroundTask) {
    if (!window.confirm('删除该任务记录和本机保存的结果？已导入的题目、资料和学习数据会保留。'))
      return;
    await action(task.id, async () => {
      await removeTask(task.id);
      if (result?.id === task.id) setResult(undefined);
    });
  }

  return (
    <div className="task-center">
      <PageHeader
        eyebrow="BACKGROUND TASKS"
        title="后台任务"
        description="处理进度和结果保存在当前设备。离开功能页面后任务会继续，可在这里查看或取消。"
        actions={
          <>
            <button
              className="button secondary"
              type="button"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
              刷新
            </button>
            {unreadCount > 0 && (
              <button
                className="button secondary"
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void action('read-all', async () => {
                    for (const task of tasks.filter((item) => terminalTask(item) && !item.read))
                      await markTaskRead(task.id);
                  })
                }
              >
                <CheckCheck size={16} />
                全部标为已读
              </button>
            )}
          </>
        }
      />
      {error && <ErrorNotice message={error} />}
      {!enabled ? (
        <Empty title="当前环境未启用后台任务" description="现有功能仍可在原页面使用。" />
      ) : (
        <>
          <div className="task-center-toolbar">
            <div className="task-center-totals" aria-live="polite">
              <span>
                <strong>{activeCount}</strong> 项处理中
              </span>
              <span>
                <strong>{unreadCount}</strong> 项未读
              </span>
            </div>
            <label className="task-center-filter">
              状态
              <select
                aria-label="后台任务状态"
                value={filter}
                onChange={(event) => setFilter(event.target.value as Filter)}
              >
                <option value="all">全部任务</option>
                <option value="active">处理中</option>
                <option value="unread">未读结果</option>
                <option value="completed">已完成</option>
                <option value="failed">失败</option>
                <option value="cancelled">已取消</option>
                <option value="interrupted">已中断</option>
              </select>
            </label>
          </div>
          <details className="task-center-help">
            <summary>任务如何继续、取消和重试？</summary>
            <p>
              任务在当前设备运行。保存数据时不能取消；其余阶段的取消会在安全检查点生效。关闭应用或服务可能中断任务，重新打开后可重试。分段任务会保留已完成的步骤，重试未完成的
              AI 步骤可能再次调用模型。
            </p>
            <p>
              结果只保存在本机。需要在原功能继续确认或应用的结果，可使用“返回原功能”；导出任务也可在这里下载文件。
            </p>
          </details>
          <section className="task-center-list" aria-label="后台任务列表">
            {!pagination.items.length && (
              <Empty
                title={tasks.length ? '没有符合条件的任务' : '还没有后台任务'}
                description={
                  tasks.length
                    ? '切换状态查看其他任务。'
                    : '导入、导出或 AI 处理产生的后台任务会显示在这里。'
                }
              />
            )}
            {pagination.items.map((task) => {
              const terminal = terminalTask(task);
              const currentResult = result?.id === task.id ? result.value : undefined;
              const summary = currentResult ? summarizeResult(currentResult) : [];
              const file = currentResult ? fileInfo(currentResult) : undefined;
              const original = returnLink(task);
              const saving = task.status === 'committing';
              const step = Math.max(0, Math.min(task.completedSteps || 0, task.total || 0));
              return (
                <article
                  className={`task-card task-status-${task.status}${!task.read && terminal ? ' is-unread' : ''}`}
                  key={task.id}
                  aria-label={displayText(task.title, 180)}
                >
                  <header className="task-card-header">
                    <div className="task-card-heading">
                      <div className="task-card-title">
                        <h2>{displayText(task.title, 180)}</h2>
                        {!task.read && terminal && (
                          <span className="task-unread-dot" aria-label="未读" />
                        )}
                      </div>
                      <div className="task-card-meta">
                        <span>创建于 {formatDate(task.createdAt)}</span>
                        <span>更新于 {formatDate(task.updatedAt)}</span>
                        {task.attempt > 1 && <span>第 {task.attempt} 次执行</span>}
                      </div>
                    </div>
                    <span className={`task-status-label task-status-${task.status}`}>
                      {!terminal ? (
                        <LoaderCircle
                          size={14}
                          className={task.status === 'queued' ? '' : 'spin'}
                        />
                      ) : task.status === 'completed' ? (
                        <Check size={14} />
                      ) : (
                        <AlertCircle size={14} />
                      )}
                      {statusLabels[task.status]}
                    </span>
                  </header>
                  <p className="task-card-message">
                    {displayText(task.message, 600) || statusLabels[task.status]}
                  </p>
                  {!terminal && (
                    <div className="task-card-progress">
                      {task.total > 0 ? (
                        <>
                          <progress
                            aria-label={`${displayText(task.title, 100)}处理进度`}
                            value={step}
                            max={task.total}
                          />
                          <span>
                            已完成 {step.toLocaleString()} / {task.total.toLocaleString()} 个步骤
                          </span>
                        </>
                      ) : (
                        <span>正在处理，进度以实际完成的步骤为准。</span>
                      )}
                    </div>
                  )}
                  {saving && (
                    <p className="task-commit-note">
                      正在写入数据，此阶段不能取消，完成后可继续操作。
                    </p>
                  )}
                  {task.error && (
                    <div className="task-card-error" role="note">
                      <AlertCircle size={16} />
                      <div>
                        <strong>
                          {displayText(task.error.message, 1200) || '任务未能完成，请重试。'}
                        </strong>
                        {task.error.code && (
                          <small>错误代码：{displayText(task.error.code, 100)}</small>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="task-card-actions">
                    {task.status === 'completed' && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() => void viewResult(task)}
                      >
                        {busy === task.id ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <CheckCheck size={15} />
                        )}
                        {currentResult ? '收起结果' : '查看结果'}
                      </button>
                    )}
                    {original && (
                      <a className="button secondary" href={original}>
                        返回原功能
                        <ArrowRight size={15} />
                      </a>
                    )}
                    {!terminal && task.cancellable && !saving && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() => void action(task.id, () => cancelTask(task.id))}
                      >
                        <X size={15} />
                        取消任务
                      </button>
                    )}
                    {['failed', 'cancelled', 'interrupted'].includes(task.status) && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void action(task.id, async () => {
                            setResult(undefined);
                            await retryTask(task.id);
                          })
                        }
                      >
                        <RefreshCw size={15} />
                        重试
                      </button>
                    )}
                    {terminal && !task.read && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!!busy}
                        onClick={() => void action(task.id, () => markTaskRead(task.id))}
                      >
                        <Check size={15} />
                        标为已读
                      </button>
                    )}
                    {terminal && (
                      <button
                        type="button"
                        className="button secondary task-delete-button"
                        disabled={!!busy}
                        onClick={() => void deleteTask(task)}
                      >
                        <Trash2 size={15} />
                        删除记录
                      </button>
                    )}
                  </div>
                  {currentResult && (
                    <section className="task-result-summary" aria-label="任务结果摘要">
                      <h3>处理结果</h3>
                      {summary.length > 0 ? (
                        <dl>
                          {summary.map((row, index) => (
                            <div key={`${row.label}-${index}`}>
                              <dt>{row.label}</dt>
                              <dd>{row.value}</dd>
                            </div>
                          ))}
                        </dl>
                      ) : (
                        <p>任务已完成，可返回原功能查看并使用结果。</p>
                      )}
                      {file && (
                        <button
                          className="button"
                          type="button"
                          disabled={!!busy}
                          onClick={() => void downloadResult(task)}
                        >
                          <Download size={16} />
                          下载文件
                        </button>
                      )}
                    </section>
                  )}
                </article>
              );
            })}
          </section>
          {filtered.length > 0 && <Pagination {...pagination} label="后台任务" />}
        </>
      )}
    </div>
  );
}
