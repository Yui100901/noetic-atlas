import { isNativeApp, nativeFetch, saveGeneratedFile } from '@platform';
import type { SQLiteMigrationPreview } from '../../../shared/models/sqlite-migration';
import { buildDataPackage, SQLITE_PACKAGE_LIMITS } from '../../../shared/packages/data-package';

/** Fetch binary directly, without JSON/Base64 amplification for a whole database. */
export async function exportSQLiteMigration(
  preview: SQLiteMigrationPreview,
  format: 'sqlite' | 'zip',
): Promise<void> {
  const params = new URLSearchParams({
    domainIds: JSON.stringify(preview.domainIds),
    fingerprint: preview.fingerprint,
  });
  const url = `/api/migrations/database?${params}`;
  const response = await (isNativeApp() ? nativeFetch(url, {}) : fetch(url));
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(
      data?.error?.message || `迁移数据库生成失败（${response.status}），请重新预览。`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 16)) !== 'SQLite format 3\u0000')
    throw new Error('返回的迁移文件不是有效 SQLite 数据库，请重新导出。');
  const title = `认知星图-${preview.scope === 'all' ? '整体' : '领域'}迁移-${new Date().toISOString().slice(0, 10)}`;
  if (format === 'sqlite') {
    await saveGeneratedFile(`${title}.sqlite`, bytes, 'application/vnd.sqlite3');
    return;
  }
  if (bytes.byteLength > SQLITE_PACKAGE_LIMITS.maxFileBytes)
    throw new Error('数据库超过 SQLite 迁移包容量上限，请改选 .sqlite 数据库格式或缩小领域范围。');
  const packet = await buildDataPackage({
    kind: 'sqlite-backup',
    title,
    payloads: [],
    files: [
      { path: 'database/migration.sqlite', bytes, mediaType: 'application/vnd.sqlite3' },
      {
        path: 'metadata/migration.json',
        bytes: new TextEncoder().encode(JSON.stringify(preview)),
        mediaType: 'application/json',
      },
    ],
    limits: SQLITE_PACKAGE_LIMITS,
  });
  await saveGeneratedFile(`${title}.zip`, packet, 'application/zip');
}
