import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { sql, type CompiledQuery, type Compilable } from 'kysely';
import { createQueryBuilder } from './query-builder.js';
import { SqliteExpressions } from './sqlite-expressions.js';
import { recordTables, type RecordTable } from './schema.js';
import { RecordProjections } from './projections.js';

/** The only native-driver boundary. Services use compiled, bound queries.
 * SQLite maintenance SQL is intentionally confined to this directory. */
export class DatabaseConnection {
  readonly query = createQueryBuilder();
  readonly expressions = new SqliteExpressions();
  readonly projections: RecordProjections;
  private readonly client: DatabaseSync;
  readonly maintenance: Pick<DatabaseSync,'exec' | 'prepare' | 'function'>;
  constructor(path: string, initialize = true) {
    this.client = new DatabaseSync(path);
    this.maintenance = { exec: value=>this.client.exec(value), prepare: value=>this.client.prepare(value), function: this.client.function.bind(this.client) };
    this.client.function('atlas_unicode_contains',{deterministic:true},(value,needle)=>Number(String(value).toLowerCase().includes(String(needle))));
    this.projections=new RecordProjections(this);
    if (initialize) { this.initialize();this.projections.initialize(); }
  }
  private initialize() {
    // Single-user portable storage deliberately keeps one-file DELETE journals.
    this.client.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    for (const table of recordTables) this.run(this.query.schema.createTable(table).ifNotExists().addColumn('id','text',c=>c.primaryKey()).addColumn('data','text',c=>c.notNull().check(sql`json_valid(data)`)));
    this.run(this.query.schema.createTable('metadata').ifNotExists().addColumn('key','text',c=>c.primaryKey()).addColumn('value','text',c=>c.notNull()));
    this.run(this.query.insertInto('metadata').values({key:'schema_version',value:'1'}).onConflict(c=>c.column('key').doNothing()));
    for (const [name,table,fields] of [
      ['papers_archived_updated_idx','papers',['archived','updatedAt']],
      ['papers_updated_idx','papers',['updatedAt']],
      ['attempts_exam_status_started_idx','attempts',['practiceMode','status','startedAt']],
      ['attempts_source_paper_status_idx','attempts',['source','paperId','status']],
      ['documents_archived_updated_idx','documents',['_archived','updatedAt']],
      ['questions_type_title_idx','questions',['type','title']],
    ] as const) {
      this.run(this.query.schema.createIndex(name).ifNotExists().on(table).expression(sql.join(fields.map(key=>this.expressions.field('data',key)))));
    }
  }
  private compiled<T>(value: Compilable<T> | CompiledQuery<T>): CompiledQuery<T> { return 'compile' in value ? value.compile() : value; }
  all<T>(value: Compilable<T> | CompiledQuery<T>): T[] { const q=this.compiled(value);return this.client.prepare(q.sql).all(...q.parameters as SQLInputValue[]) as T[]; }
  one<T>(value: Compilable<T> | CompiledQuery<T>): T | undefined { const q=this.compiled(value);return this.client.prepare(q.sql).get(...q.parameters as SQLInputValue[]) as T | undefined; }
  run<T>(value: Compilable<T> | CompiledQuery<T>) { const q=this.compiled(value);return this.client.prepare(q.sql).run(...q.parameters as SQLInputValue[]); }
  explain<T>(value: Compilable<T> | CompiledQuery<T>) { const q=this.compiled(value);return this.client.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.parameters as SQLInputValue[]); }
  transaction<T>(fn:()=>T):T {
    // Savepoints allow nested imports, maintenance and application writes.
    this.client.exec('SAVEPOINT atlas_repository_transaction');
    try { const value=fn();this.client.exec('RELEASE SAVEPOINT atlas_repository_transaction');return value; }
    catch(error) { this.client.exec('ROLLBACK TO SAVEPOINT atlas_repository_transaction; RELEASE SAVEPOINT atlas_repository_transaction');throw error; }
  }
  private assertTable(table:RecordTable) { if(!(recordTables as readonly string[]).includes(table))throw new Error('Unknown record table'); }
  getRecord<T=any>(table:RecordTable,id:string):T|undefined { this.assertTable(table);const row=this.one(this.query.selectFrom(table).select('data').where('id','=',id));return row?JSON.parse(row.data):undefined; }
  records<T=any>(table:RecordTable):T[] { this.assertTable(table);return this.all(this.query.selectFrom(table).select('data')).map(row=>JSON.parse(row.data)); }
  putRecord(table:RecordTable,id:string,data:unknown) { this.assertTable(table);const row={id,data:JSON.stringify(data)};this.run(this.query.insertInto(table).values(row).onConflict(c=>c.column('id').doUpdateSet({data:row.data}))); }
  deleteRecord(table:RecordTable,id:string) { this.assertTable(table);this.run(this.query.deleteFrom(table).where('id','=',id)); }
  hasTable(table:string):boolean { return Boolean(this.client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
  compact() { this.client.exec('VACUUM'); }
  backupTo(path:string) { return backup(this.client,path); }
  snapshotTo(path:string) { this.client.prepare('VACUUM INTO ?').run(path); }
  close() { this.client.close(); }
  /** Diagnostic compatibility for tests/offline maintenance, never services. */
  prepare(value:string) { return this.client.prepare(value); }
  exec(value:string) { this.client.exec(value); }
}
