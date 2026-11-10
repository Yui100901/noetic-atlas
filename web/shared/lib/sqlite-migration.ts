import {
  downloadTaskFile,
  shouldBackground,
  startBackgroundTask,
  waitForTaskResult,
} from '../../features/tasks/client';
import { isNativeApp, nativeFetch, saveGeneratedFile } from '@platform';
import type { SQLiteMigrationPreview } from '../../../shared/models/sqlite-migration';

/** Fetch binary directly, without JSON/Base64 amplification for a whole database. */
export async function exportSQLiteMigration(
  preview: SQLiteMigrationPreview,
  format: 'sqlite' | 'zip',
  signal?: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({
    domainIds: JSON.stringify(preview.domainIds),
    fingerprint: preview.fingerprint,
    format,
  });
  const url = `/api/migrations/database?${params}`;
  const title = `认知星图-${preview.scope === 'all' ? '整体' : '领域'}迁移-${new Date().toISOString().slice(0, 10)}`;
  const mime = format === 'zip' ? 'application/zip' : 'application/vnd.sqlite3';
  if (shouldBackground(url, { method: 'GET' })) {
    signal?.throwIfAborted();
    const task = await startBackgroundTask({ operation: url, method: 'GET' });
    window.dispatchEvent(
      new CustomEvent('atlas-task-started', { detail: { id: task.id, operation: url } }),
    );
    const result = await waitForTaskResult(task.id, undefined, signal);
    if (result.binaryByteLength === undefined || result.contentType !== mime)
      throw new Error('迁移文件格式无效，请重新导出。');
    await downloadTaskFile(task.id, `${title}.${format}`, mime, signal);
    return;
  }
  const response = await (isNativeApp() ? nativeFetch(url, { signal }) : fetch(url, { signal }));
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      data?.error?.message || `迁移数据库生成失败（${response.status}），请重新预览。`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (
    format === 'sqlite' &&
    new TextDecoder().decode(bytes.slice(0, 16)) !== 'SQLite format 3\u0000'
  )
    throw new Error('返回的迁移文件不是有效 SQLite 数据库，请重新导出。');
  if (format === 'zip' && (bytes[0] !== 0x50 || bytes[1] !== 0x4b))
    throw new Error('返回的迁移文件不是有效 ZIP 包，请重新导出。');
  signal?.throwIfAborted();
  await saveGeneratedFile(`${title}.${format}`, bytes, mime);
}
