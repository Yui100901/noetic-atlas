import { Capacitor, CapacitorHttp } from '@capacitor/core';
import initSqlJs from 'sql.js';
import { createLocalRuntime } from './runtime';
import { deviceStorage } from './storage';
import { saveGeneratedFile } from './generated-file';
import './native.css';
import { configureAiTransport } from '../shared/ai/ai-transport';
import { createEmptyInitialData } from '../shared/models/initial-data';
export { saveGeneratedFile } from './generated-file';

export const isNativeApp = () => Capacitor.isNativePlatform();
if (isNativeApp()) configureAiTransport(async (url, options) => {
  // Provider traffic bypasses WebView CORS, while /api still uses local SQLite.
  const result = await CapacitorHttp.request({
    url, method: options.method, headers: options.headers, data: JSON.parse(options.body),
    responseType: 'text', connectTimeout: options.timeoutMs, readTimeout: options.timeoutMs,
    disableRedirects: true,
  });
  return { status: result.status, body: typeof result.data === 'string' ? result.data : JSON.stringify(result.data) };
});
let runtime: ReturnType<typeof createLocalRuntime> | undefined;
function local() {
  if (!runtime) runtime = (async () => {
    document.documentElement.classList.add('native-app');
    const sql = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
    return createLocalRuntime(sql, createEmptyInitialData(), deviceStorage);
  })().catch(error => { runtime = undefined; throw error; });
  return runtime;
}
export async function nativeFetch(url: string, options: RequestInit = {}) { return (await local()).fetch(url, options); }
export async function nativePreviewSQLiteRestore(file: File) { return (await local()).previewRestore(new Uint8Array(await file.arrayBuffer()), file.name); }
export async function nativeConfirmSQLiteRestore(token: string) { return (await local()).restore(token); }
export async function nativeLatestRecoveryBackup() { return (await local()).latestRecoveryBackup(); }
export async function nativeDownloadRecoveryBackup(id: string) { await saveGeneratedFile('认知星图-恢复前数据库.sqlite', await (await local()).recoveryBackupBytes(id), 'application/vnd.sqlite3'); }
export async function nativeDownload(url: string, filename?: string) {
  const response = await nativeFetch(url);
  if (!response.ok) { const value = await response.json(); throw new Error(value.error?.message || '导出失败'); }
  const defaultName = url.includes('backup.sqlite') ? '认知星图-学习数据库.sqlite' : url.includes('/papers/') ? '认知星图-题集.md' : '认知星图-完整备份.json';
  const bytes = new Uint8Array(await response.arrayBuffer());
  await saveGeneratedFile(filename || defaultName, bytes, url.includes('backup.sqlite') ? 'application/vnd.sqlite3' : response.headers.get('Content-Type') || 'application/octet-stream');
}
