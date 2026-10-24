import type { SqlJsStatic } from 'sql.js';
import { buildApp } from '../server/index';
import { configureSQLite, currentDatabase } from './shims/sqlite';
import { configureSeed, SEED_PATH } from './shims/fs';
import type { LocalApp } from './shims/fastify';

export interface DurableStorage { load(): Promise<Uint8Array | undefined>; save(bytes: Uint8Array): Promise<void> }

/** All local routes reuse server/index, validation, Store and practice verbatim.
 * A successful mutation is acknowledged only after its SQLite bytes are durable.
 * A failed file commit restores the same live DB object to its previous snapshot.
 */
export async function createLocalRuntime(sql: SqlJsStatic, seed: unknown, storage: DurableStorage) {
  const initial = await storage.load(); configureSQLite(sql, initial); configureSeed(seed);
  let startupMigrated = false;
  const app = await buildApp({ databasePath: ':memory:', seedPath: SEED_PATH, staticRoot: '/not-a-web-server', native: true, onDataMigrated:()=>{startupMigrated=true;} }) as unknown as LocalApp;
  const database = currentDatabase();
  if (!initial || startupMigrated) {
    try { await storage.save(database.export()); }
    catch (error) { await app.close(); throw error; }
  }
  let queue = Promise.resolve(); let closed = false;
  const fetch = (url: string, options: RequestInit = {}): Promise<Response> => {
    // Reads are queued too: they must not observe a mutation awaiting durable commit.
    const operation = queue.then(async () => {
      if (closed) throw new Error('本地数据库已关闭');
      if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
      const method=(options.method||'GET').toUpperCase();
      // These queries carry JSON through POST rather than a long URL. They
      // must also work with read-only storage and never trigger a full save.
      const readOnlyPost=method==='POST'&&['/api/settings/import/preview','/api/questions/metadata','/api/learning/card-summaries'].includes(new URL(url,'https://localhost').pathname);
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(method)&&!readOnlyPost;
      const before = write ? database.export() : undefined;
      const response = await app.inject(url, options);
      if (write) {
        if (!response.ok) database.restore(before!);
        else try { await storage.save(database.export()); }
        catch {
          database.restore(before!);
          return new Response(JSON.stringify({ error: { code: 'LOCAL_STORAGE_FAILED', message: '保存到手机失败，本次修改已撤销。请检查剩余空间后重试，并及时导出备份。' } }), { status: 507, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return response;
    });
    queue = operation.then(() => undefined, () => undefined); return operation;
  };
  return { fetch, close: async () => { await queue; closed = true; await app.close(); } };
}
