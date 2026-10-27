import type { SqlJsStatic } from 'sql.js';
import { buildApp } from '../server/index';
import { configureSQLite, currentDatabase } from './shims/sqlite';
import { configureSeed, SEED_PATH } from './shims/fs';
import type { LocalApp } from './shims/fastify';
import type { SQLiteRecoveryBackup, SQLiteRestorePreview, SQLiteRestoreResult } from '../shared/models/sqlite-restore';
import { prepareSQLiteRestore, shareableRecoveryBytes } from './restore-validation';
import { databaseCounts, hasActiveExam } from './database/restore-database';
import { pendingFailureAudit, replayFailureAudit } from './database/ai-audit-commit';
import { dailyPushTimerDelay, dailyPushRefreshesAfter } from '../server/scheduling/daily-push';
import { isDailyPushDue } from '../server/modules/daily-push/calendar';
import type { DailyPushOverview, DailyPushSettings } from '../shared/models/daily-push';

export interface DurableStorage {
  load(): Promise<Uint8Array | undefined>;
  save(bytes: Uint8Array): Promise<void>;
  createRecoveryBackup?(bytes: Uint8Array): Promise<SQLiteRecoveryBackup>;
  loadRecoveryBackup?(id: string): Promise<Uint8Array>;
  latestRecoveryBackup?(): Promise<SQLiteRecoveryBackup | undefined>;
}
const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined) => left === undefined || right === undefined ? left === right : left.length === right.length && left.every((value, index) => value === right[index]);
async function sha256(bytes: Uint8Array) { const value = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer); return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

/** All local routes reuse server/index, validation, Store and practice verbatim.
 * A successful mutation is acknowledged only after its SQLite bytes are durable.
 * A failed file commit restores the same live DB object to its previous snapshot.
 */
export async function createLocalRuntime(sql: SqlJsStatic, seed: unknown, storage: DurableStorage, options: { dailyPushNow?: () => Date; dailyPushScheduler?: boolean } = {}) {
  const initial = await storage.load(); configureSQLite(sql, initial); configureSeed(seed);
  const dailyNow = options.dailyPushNow || (() => new Date());
  let requestDailyAt: Date | undefined;
  let startupMigrated = false;
  const app = await buildApp({ databasePath: ':memory:', seedPath: SEED_PATH, staticRoot: '/not-a-web-server', native: true, dailyPushNow: () => requestDailyAt || dailyNow(), onDataMigrated:()=>{startupMigrated=true;} }) as unknown as LocalApp;
  const database = currentDatabase();
  if (!initial || startupMigrated) {
    try { await storage.save(database.export()); }
    catch (error) { await app.close(); throw error; }
  }
  let queue = Promise.resolve(); let closed = false; let revision = 0; let reloadRequired = false;
  let closing = false, dailyRequested = false, dailyChecking: Promise<void> | undefined;
  let dailyTimer: ReturnType<typeof setTimeout> | undefined;
  let durableBaseline = (await storage.load())?.slice();
  let pending: { preview: SQLiteRestorePreview; bytes: Uint8Array; revision: number; disk: Uint8Array | undefined } | undefined;
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const operation = queue.then(async () => { if (closed) throw new Error('本地数据库已关闭'); return run(); });
    queue = operation.then(() => undefined, () => undefined); return operation;
  }
  function assertNoActiveExam() {
    if (hasActiveExam(database)) throw new Error('考试进行中，请先交卷，再恢复数据库');
  }
  function stopDailyTimer() { if (dailyTimer !== undefined) { clearTimeout(dailyTimer); dailyTimer = undefined; } }
  const fetch = (url: string, options: RequestInit = {}): Promise<Response> => {
    // Reads are queued too: they must not observe a mutation awaiting durable commit.
    const operation = enqueue(async () => {
      if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      const method=(options.method||'GET').toUpperCase();
      const pathname = new URL(url, 'https://localhost').pathname;
      // These queries carry JSON through POST rather than a long URL. They
      // must also work with read-only storage and never trigger a full save.
      const readOnlyPost=method==='POST'&&['/api/settings/import/preview','/api/questions/metadata','/api/learning/card-summaries','/api/question-feedback/summaries'].includes(new URL(url,'https://localhost').pathname);
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method)&&!readOnlyPost;
      // Freeze only the daily calendar for this serialized operation. A no-op
      // check must not export/rewrite a potentially large SQLite file, and the
      // preflight and handler must agree even across the midnight boundary.
      requestDailyAt = new Date(dailyNow().getTime());
      let noDailyMutation = false;
      if (method === 'POST' && pathname === '/api/daily-push/check') {
        const preflight = await app.inject('/api/daily-push');
        if (preflight.ok) {
          const overview = await preflight.json() as DailyPushOverview;
          noDailyMutation = !overview.config.enabled || !!overview.today || !isDailyPushDue(overview.config, requestDailyAt);
        } else if (preflight.status === 409) noDailyMutation = true;
      }
      const write = mutation && !noDailyMutation;
      if (write && reloadRequired) return new Response(JSON.stringify({ error: { code: 'DATABASE_RESTORED', message: '数据库已恢复，请刷新应用后继续修改。' } }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      const before = write ? database.export() : undefined;
      const startedAt = Date.now();
      let response: Response;
      try { response = await app.inject(url, options); }
      catch (error) { if (write) database.restore(before!); throw error; }
      if (write) {
        const audit = !response.ok ? pendingFailureAudit(database, response, pathname, startedAt) : undefined;
        if (!response.ok) { database.restore(before!); if (audit) replayFailureAudit(database, audit); }
        if (response.ok || audit) try { const bytes = database.export(); await storage.save(bytes); durableBaseline = bytes.slice(); revision++; }
        catch {
          database.restore(before!);
          return new Response(JSON.stringify({ error: { code: 'LOCAL_STORAGE_FAILED', message: '保存到手机失败，本次修改已撤销。请检查剩余空间后重试，并及时导出备份。' } }), { status: 507, headers: { 'Content-Type': 'application/json' } });
        }
      }
      requestDailyAt = undefined;
      return response;
    });
    return operation.finally(() => { requestDailyAt = undefined; }).then(response => {
      if (response.ok && dailyPushRefreshesAfter((options.method || 'GET').toUpperCase(), new URL(url, 'https://localhost').pathname)) void refreshDailySchedule();
      return response;
    });
  };
  /** Native timers cannot write Store directly: all generated papers and
   * notifications commit through fetch(), including rollback on disk failure. */
  function refreshDailySchedule(): Promise<void> {
    if (closing || closed || reloadRequired || options.dailyPushScheduler === false) return Promise.resolve();
    dailyRequested = true; stopDailyTimer();
    if (dailyChecking) return dailyChecking;
    dailyChecking = (async () => {
      let config: DailyPushSettings | undefined;
      try {
        do {
          dailyRequested = false;
          const response = await fetch('/api/daily-push');
          // The active exam guard stays intact. Submission/sync wakes us later.
          if (response.status === 409) { config = undefined; return; }
          if (!response.ok) throw new Error('Daily push overview unavailable');
          const overview = await response.json() as DailyPushOverview; config = overview.config;
          if (config.enabled && !overview.today && isDailyPushDue(config, dailyNow())) await fetch('/api/daily-push/check', { method: 'POST' });
        } while (dailyRequested && !closing && !closed && !reloadRequired);
      } catch {
        // A later visible/foreground check retries. Never acknowledge an
        // uncommitted generated paper or expose private error payloads.
      } finally {
        dailyChecking = undefined;
        if (!closing && !closed && !reloadRequired && config?.enabled) {
          dailyTimer = setTimeout(() => { dailyTimer = undefined; void refreshDailySchedule(); }, dailyPushTimerDelay(dailyNow(), config));
          if (typeof dailyTimer === 'object' && 'unref' in dailyTimer) dailyTimer.unref();
        }
      }
    })();
    return dailyChecking;
  }
  await refreshDailySchedule();
  return {
    fetch,
    previewRestore(bytes: Uint8Array, filename: string): Promise<SQLiteRestorePreview> {
      // Own this immutable snapshot before waiting behind any concurrent writes.
      const selected = bytes.slice();
      return enqueue(async () => {
        pending = undefined; assertNoActiveExam();
        const disk = await storage.load();
        if (!sameBytes(disk, durableBaseline)) throw new Error('本机数据库文件已在应用外改变，请重启应用后重新预览');
        const prepared = await prepareSQLiteRestore(sql, selected);
        const preview: SQLiteRestorePreview = { token: crypto.randomUUID(), filename, byteLength: selected.length, sha256: await sha256(selected), schemaVersion: 1, counts: prepared.counts, currentCounts: databaseCounts(database), sourceHadAiKey: prepared.sourceHadAiKey, activeExamCount: prepared.activeExamCount };
        pending = { preview, bytes: prepared.bytes, revision, disk: disk?.slice() };
        return preview;
      });
    },
    restore(token: string): Promise<SQLiteRestoreResult> {
      return enqueue(async () => {
        assertNoActiveExam();
        const prepared = pending; pending = undefined;
        if (!prepared || token !== prepared.preview.token || prepared.revision !== revision) throw new Error('恢复预览已失效，或本机数据已修改，请重新选择文件并预览');
        if (!sameBytes(await storage.load(), prepared.disk)) throw new Error('本机数据库文件在预览后发生变化，已取消恢复，请重启应用');
        if (!storage.createRecoveryBackup) throw new Error('当前存储无法保存独立的恢复前副本，已取消恢复');
        const before = database.export();
        const recoveryBackup = await storage.createRecoveryBackup(before);
        let replacement: ReturnType<typeof database.beginReplacement> | undefined;
        try {
          // Open the already validated and upgraded candidate before touching
          // disk. Existing Store/routes retain this exact connection object.
          replacement = database.beginReplacement(prepared.bytes);
          await storage.save(prepared.bytes);
          replacement.commit();
          durableBaseline = prepared.bytes.slice(); revision++; reloadRequired = true;
          return { recoveryBackup };
        } catch (error) {
          replacement?.rollback();
          // save() normally restores disk atomically. If a bridge failed during
          // recovery too, use the independent copy, never a rotated PREVIOUS.
          try {
            if (!sameBytes(await storage.load(), durableBaseline)) await storage.save(before);
            durableBaseline = (await storage.load())?.slice();
          } catch {
            throw new Error(`恢复失败，原数据已恢复到内存；恢复前完整副本仍保存在本机（${recoveryBackup.id}）。请导出该副本并检查手机存储后重启应用。`);
          }
          throw new Error(`恢复失败，原数据已保留，应用可继续使用。恢复前副本：${recoveryBackup.id}。${error instanceof Error ? error.message : ''}`);
        }
      });
    },
    latestRecoveryBackup: () => enqueue(async () => storage.latestRecoveryBackup?.()),
    recoveryBackupBytes: (id: string) => enqueue(async () => {
      if (!storage.loadRecoveryBackup) throw new Error('当前存储不支持读取恢复前副本');
      return shareableRecoveryBytes(sql, await storage.loadRecoveryBackup(id));
    }),
    close: async () => { closing = true; stopDailyTimer(); await dailyChecking; await queue; closed = true; pending = undefined; await app.close(); },
  };
}
