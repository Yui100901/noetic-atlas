import type { Database, SqlJsStatic } from 'sql.js';
import { z } from 'zod';
import { recordTables } from '../../server/database/schema';
import type { DatabaseSync } from '../shims/sqlite';
const coreTables = ['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'attempts', 'study', 'reviews'];
const derivedTables = ['question_read_model', 'paper_read_model', 'projection_pending', 'asset_references', 'atlas_question_order', 'search_read_model', 'search_projection_pending'];
const stamp = z.string().datetime({ offset: true });
const invalid = (message: string): never => { throw new Error(`SQLite 备份校验失败：${message}`); };
const rows = (db: Database, sql: string) => {
  const statement = db.prepare(sql);
  try { const values: Record<string, unknown>[] = []; while (statement.step()) values.push(statement.getAsObject()); return values; }
  finally { statement.free(); }
};
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Inspect the ORIGINAL file before Store/buildApp can create any tables or seed it.
 * Imported triggers and disposable read models are discarded in this copy, before
 * any application writes. Trusted application code recreates its own projections.
 */
export function inspectSQLite(sql: SqlJsStatic, bytes: Uint8Array) {
  if (bytes.length < 100 || new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0') invalid('不是 SQLite 3 数据库文件');
  const db = new sql.Database(bytes);
  try {
    const integrity = rows(db, 'PRAGMA integrity_check');
    if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') invalid('数据库完整性检查未通过');
    if (rows(db, 'PRAGMA foreign_key_check').length) invalid('SQLite 外键引用无效');
    if (Object.values(rows(db, 'PRAGMA user_version')[0]!)[0] !== 0 || Object.values(rows(db, 'PRAGMA application_id')[0]!)[0] !== 0) invalid('数据库版本或应用标识不受当前版本支持');
    const objects = rows(db, "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
    const names = new Set(objects.filter(row => row.type === 'table').map(row => String(row.name)));
    if (!names.has('metadata') || coreTables.some(table => !names.has(table))) invalid('缺少认知星图核心数据表或元数据');
    const allowed = new Set<string>([...recordTables, ...derivedTables, 'metadata']);
    if ([...names].some(name => !allowed.has(name)) || objects.some(row => row.type === 'view')) invalid('包含当前应用不支持的数据表或视图');
    for (const table of ['metadata', ...recordTables.filter(table => names.has(table))]) {
      const columns = rows(db, `PRAGMA table_info(${quote(table)})`);
      const key = table === 'metadata' ? 'key' : 'id', value = table === 'metadata' ? 'value' : 'data';
      if (columns.length !== 2 || !columns.some(c => c.name === key && String(c.type).toUpperCase() === 'TEXT' && c.pk === 1) || !columns.some(c => c.name === value && String(c.type).toUpperCase() === 'TEXT' && c.notnull === 1)) invalid(`数据表结构不受支持：${table}`);
      for (const row of rows(db, `SELECT * FROM ${quote(table)}`)) {
        if (typeof row[key] !== 'string' || !row[key] || typeof row[value] !== 'string') invalid(`数据表记录格式无效：${table}`);
        if (table === 'metadata') continue;
        let record: any;
        try { record = JSON.parse(row.data as string); } catch { invalid(`记录不是有效 JSON：${table}`); }
        if (!record || typeof record !== 'object' || Array.isArray(record)) invalid(`记录必须是对象：${table}`);
        const expected = table === 'ai_settings' ? 'local' : table === 'study' ? record.questionId : table === 'study_parts' ? JSON.stringify([record.questionId, record.partId]) : record.id;
        if (row.id !== expected) invalid(`记录主键与内容不一致：${table}`);
      }
    }
    const metadata = new Map(rows(db, 'SELECT key,value FROM metadata').map(row => [String(row.key), String(row.value)]));
    if (metadata.get('schema_version') !== '1') invalid('schema_version 不是受支持的版本 1');
    if ([...metadata.keys()].some(key => !['schema_version', 'seed_initialized', 'read_projection_version','question_history_version','search_projection_version'].includes(key))) invalid('包含当前版本不支持的元数据');
    if (metadata.has('seed_initialized') && !stamp.safeParse(metadata.get('seed_initialized')).success) invalid('初始化元数据时间无效');
    if (metadata.has('read_projection_version') && !['1', '2', '3', '4', '5'].includes(metadata.get('read_projection_version')!)) invalid('读取模型版本比当前应用更新');
    if(metadata.has('question_history_version')&&metadata.get('question_history_version')!=='1')invalid('单题历史版本不受当前应用支持');
    if(metadata.has('search_projection_version')&&metadata.get('search_projection_version')!=='1')invalid('统一搜索索引版本比当前应用更新');
    for (const row of objects.filter(row => row.type === 'trigger')) db.run(`DROP TRIGGER ${quote(String(row.name))}`);
    for (const table of derivedTables) if (names.has(table)) db.run(`DROP TABLE ${quote(table)}`);
    for (const row of rows(db, "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")) db.run(`DROP INDEX ${quote(String(row.name))}`);
    db.run("DELETE FROM metadata WHERE key='read_projection_version'");
    db.run("DELETE FROM metadata WHERE key='search_projection_version'");
    return db.export();
  } finally { db.close(); }
}

export function databaseCounts(database: { prepare(sql: string): { get(): any } }) {
  return Object.fromEntries(recordTables.map(table => [table, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count)]));
}

/** Native adapter maintenance; application services never issue driver SQL. */
export function hasActiveExam(database: DatabaseSync) { return activeExamCount(database) > 0; }
export function activeExamCount(database: DatabaseSync) { return Number(database.prepare("SELECT COUNT(*) AS count FROM attempts WHERE json_extract(data,'$.practiceMode')='exam' AND json_extract(data,'$.status')='in_progress'").get()!.count); }
export function redactRestoreAiSettings(database: DatabaseSync) {
  for (const row of database.prepare('SELECT id,data FROM ai_settings').all()) {
    const value = JSON.parse(String(row.data));
    database.prepare('UPDATE ai_settings SET data=? WHERE id=?').run(JSON.stringify({ ...value, key: '', enabled: false }), row.id!);
  }
  database.exec('VACUUM');
}
