import type { Database, SqlJsStatic, SqlValue } from 'sql.js';

let engine: SqlJsStatic;
let initialBytes: Uint8Array | undefined;
let newest: DatabaseSync;
const copies = new Map<string, DatabaseSync>();
export function configureSQLite(sql: SqlJsStatic, bytes?: Uint8Array) { engine = sql; initialBytes = bytes; }
export function currentDatabase() { return newest; }
/** Isolated validation copies never replace the live runtime's connection. */
export function databaseForPath(path: string) { const database = copies.get(path); if (!database) throw new Error('数据库副本尚未打开'); return database; }

// Deliberately implements only the synchronous surface used by server/Store.
// It is real SQLite (WASM), not a JSON imitation of SQL.
export class DatabaseSync {
  private value: Database;
  private readonly functions = new Map<string,(...args: any[])=>any>();
  constructor(path: string, _options?: unknown) {
    if (!engine) throw new Error('SQLite 尚未初始化');
    // Backups are independent virtual files. Opening a copy for redaction must
    // neither consume startup bytes nor replace the live persistence target.
    const copy = existsSync(path) ? readFileSync(path) : undefined;
    if (copy instanceof Uint8Array) { this.value = new engine.Database(copy); copies.set(path, this); }
    else { this.value = new engine.Database(initialBytes); initialBytes = undefined; newest = this; }
  }
  exec(sql: string) { this.value.run(sql); }
  function(name: string, _options: { deterministic?: boolean }, callback: (...args: any[])=>any) { this.functions.set(name,callback);this.value.create_function(name,callback); }
  prepare(sql: string) {
    const rows = (...parameters: SqlValue[]) => {
      const statement = this.value.prepare(sql);
      try { statement.bind(parameters); const result: Record<string, SqlValue>[] = []; while (statement.step()) result.push(statement.getAsObject()); return result; }
      finally { statement.free(); }
    };
    return {
      all: (...parameters: SqlValue[]) => rows(...parameters),
      get: (...parameters: SqlValue[]) => rows(...parameters)[0],
      run: (...parameters: SqlValue[]) => { this.value.run(sql, parameters); return { changes: this.value.getRowsModified(), lastInsertRowid: 0 }; },
    };
  }
  private restoreConnectionState(value = this.value) { value.run('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');for(const [name,callback] of this.functions)value.create_function(name,callback); }
  // sql.js export closes/reopens the connection internally. TEMP caches and
  // registered functions disappear just as they do after a rollback restore.
  export() { const bytes=this.value.export();this.restoreConnectionState();return bytes; }
  restore(bytes: Uint8Array) {
    // Allocation/opening can fail. Keep the old connection usable until the
    // replacement has opened and restored every registered SQL function.
    const replacement = new engine.Database(bytes);
    try { this.restoreConnectionState(replacement); } catch (error) { replacement.close(); throw error; }
    this.value.close(); this.value = replacement;
  }
  /** Keep the original live connection until replacement persistence succeeds.
   * A disk failure rolls back without allocating/reopening the original DB. */
  beginReplacement(bytes: Uint8Array) {
    const original = this.value, replacement = new engine.Database(bytes);
    try { this.restoreConnectionState(replacement); } catch (error) { replacement.close(); throw error; }
    this.value = replacement; let finished = false;
    return {
      commit: () => { if (!finished) { finished = true; original.close(); } },
      rollback: () => { if (!finished) { finished = true; this.value = original; replacement.close(); } },
    };
  }
  close() { this.value.close(); for (const [path, database] of copies) if (database === this) copies.delete(path); }
}
// Used by the unchanged server backup route, backed by the virtual temporary fs.
import { existsSync, readFileSync, setVirtualFile } from './fs';
export async function backup(database: DatabaseSync, path: string) { setVirtualFile(path, database.export()); }
