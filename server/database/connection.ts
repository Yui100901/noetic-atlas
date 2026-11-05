import {createHash} from 'node:crypto';
import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { sql, type CompiledQuery, type Compilable } from 'kysely';
import { createQueryBuilder } from './query-builder.js';
import { SqliteExpressions } from './sqlite-expressions.js';
import { recordTables, type RecordTable } from './schema.js';
import { RecordProjections } from './projections.js';
import { StartupValidation } from './startup-validation.js';

/** The only native-driver boundary. Services use compiled, bound queries.
 * SQLite maintenance SQL is intentionally confined to this directory. */
export class DatabaseConnection {
  readonly schemaChanged: boolean;
  readonly query = createQueryBuilder();
  readonly expressions = new SqliteExpressions();
  readonly projections: RecordProjections;
  readonly startupValidation: StartupValidation;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private readEpoch=0;
  private readonly client: DatabaseSync;
  readonly maintenance: Pick<DatabaseSync,'exec' | 'prepare' | 'function'>;
  constructor(path: string, initialize = true) {
    this.client = new DatabaseSync(path);
    this.maintenance = { exec: value=>this.client.exec(value), prepare: value=>this.client.prepare(value), function: this.client.function.bind(this.client) };
    this.client.function('atlas_record_fingerprint',{deterministic:true},value=>createHash('sha256').update(String(value)).digest('hex'));
    this.client.function('atlas_unicode_contains',{deterministic:true},(value,needle)=>Number(String(value).toLowerCase().includes(String(needle))));
    this.projections=new RecordProjections(this);
    this.startupValidation=new StartupValidation(this);
    const missingTables = initialize && recordTables.some(table => !this.hasTable(table));
    this.schemaChanged = false;
    if (initialize) { this.initialize(); const projectionsChanged=this.projections.initialize(), validationChanged=this.startupValidation.initialize(); this.schemaChanged = projectionsChanged || validationChanged || missingTables; }
  }
  private initialize() {
    // Single-user portable storage deliberately keeps one-file DELETE journals.
    this.client.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    for (const table of recordTables) this.run(this.query.schema.createTable(table).ifNotExists().addColumn('id','text',c=>c.primaryKey()).addColumn('data','text',c=>c.notNull().check(sql`json_valid(data)`)));
    this.run(this.query.schema.createTable('metadata').ifNotExists().addColumn('key','text',c=>c.primaryKey()).addColumn('value','text',c=>c.notNull()));
    this.run(this.query.insertInto('metadata').values({key:'schema_version',value:'1'}).onConflict(c=>c.column('key').doNothing()));
    for (const [name,table,fields] of [
      ['focus_sessions_paper_status_updated_idx','focus_sessions',['paperId','status','updatedAt']],
      ['learning_days_date_idx','learning_days',['dateKey']],
      ['learning_task_results_day_idx','learning_task_results',['dayId']],
      ['focus_sessions_learning_day_idx','focus_sessions',['learningDayId']],
      ['attempts_learning_day_idx','attempts',['learningDayId']],

      ['papers_archived_updated_idx','papers',['archived','updatedAt']],
      ['papers_updated_idx','papers',['updatedAt']],
      ['attempts_exam_status_started_idx','attempts',['practiceMode','status','startedAt']],
      ['attempts_source_paper_status_idx','attempts',['source','paperId','status']],
      ['learning_results_source_paper_idx','learning_results',['source','paperId']],
      ['learning_results_submitted_idx','learning_results',['submittedAt']],
      ['attempts_status_submitted_idx','attempts',['status','submittedAt']],
      ['reviews_reviewed_idx','reviews',['reviewedAt']],
      ['review_cards_due_idx','review_cards',['suspended','dueAt']],
      ['review_cards_question_part_idx','review_cards',['questionId','partId']],
      ['review_events_card_occurred_idx','review_events',['cardId','occurredAt']],
      ['review_events_attempt_idx','review_events',['attemptId']],
      ['question_history_question_part_date_idx','question_history',['questionId','partId','submittedAt']],
      ['question_history_attempt_idx','question_history',['attemptId']],
      ['documents_archived_updated_idx','documents',['_archived','updatedAt']],
      ['document_versions_document_idx','document_versions',['documentId','versionId']],
      ['document_drafts_context_updated_idx','document_drafts',['documentId','updatedAt']],
      ['question_drafts_context_updated_idx','question_drafts',['questionId','updatedAt']],
      ['question_revisions_context_sequence_idx','question_revisions',['questionId','sequence']],
      ['ai_workspace_drafts_context_updated_idx','ai_workspace_drafts',['kind','contextId','updatedAt']],
      ['questions_type_title_idx','questions',['type','title']],
      ['question_feedback_question_status_idx','question_feedback',['questionId','status']],
      ['quality_fingerprints_prompt_idx','quality_fingerprints',['promptHash']],
      ['quality_issues_question_status_idx','quality_issues',['questionId','status']],
      ['quality_issues_status_rule_idx','quality_issues',['status','rule','severity']],
      ['quality_scans_created_idx','quality_scans',['createdAt']],
      ['question_feedback_status_updated_idx','question_feedback',['status','updatedAt']],
      ['ai_runs_status_created_idx','ai_runs',['status','createdAt']],
      ['ai_runs_job_created_idx','ai_runs',['jobId','createdAt']],
    ] as const) {
      this.run(this.query.schema.createIndex(name).ifNotExists().on(table).expression(sql.join(fields.map(key=>this.expressions.field('data',key)))));
    }
    this.run(this.query.schema.createIndex('questions_vocabulary_prompt_idx').ifNotExists().on('questions').expression(sql.join([
      this.expressions.nestedField('data',['vocabulary','language']),
      this.expressions.nestedField('data',['vocabulary','meaningPrompt']),
      this.expressions.field('data','status'),
    ])));
  }
  private compiled<T>(value: Compilable<T> | CompiledQuery<T>): CompiledQuery<T> { return 'compile' in value ? value.compile() : value; }
  private statement(text: string) {
    let statement=this.statements.get(text);
    if (statement) this.statements.delete(text);
    else statement=this.client.prepare(text);
    this.statements.set(text,statement);
    if(this.statements.size>256)this.statements.delete(this.statements.keys().next().value!);
    return statement;
  }
  all<T>(value: Compilable<T> | CompiledQuery<T>): T[] { const q=this.compiled(value);return this.statement(q.sql).all(...q.parameters as SQLInputValue[]) as T[]; }
  one<T>(value: Compilable<T> | CompiledQuery<T>): T | undefined { const q=this.compiled(value);return this.statement(q.sql).get(...q.parameters as SQLInputValue[]) as T | undefined; }
  run<T>(value: Compilable<T> | CompiledQuery<T>) { const q=this.compiled(value);return this.statement(q.sql).run(...q.parameters as SQLInputValue[]); }
  /** Bounded batches stay below SQLite's conservative 999-parameter limit;
   * identifiers come only from the code-owned projection row builders. */
  upsertProjectionRows(table:'question_read_model'|'paper_read_model'|'document_read_model'|'search_read_model',key:'id'|'key',rows:Array<{data:string}&Record<string,string|number|null>>) {
    if(!rows.length)return;
    const columns=Object.keys(rows[0]!),size=Math.max(1,Math.min(100,Math.floor(900/columns.length)));
    const updates=Object.fromEntries(columns.filter(column=>column!==key).map(column=>[column,sql.ref(`excluded.${column}`)]));
    for(let offset=0;offset<rows.length;offset+=size)this.run(this.query.insertInto(table).values(rows.slice(offset,offset+size)).onConflict(c=>c.column(key).doUpdateSet(updates)));
  }
  /** Cross-connection commits and local writes invalidate cached aggregates.
   * WASM additionally supplies an epoch when its underlying DB is replaced. */
  readVersion(): string {
    const external=this.statement('PRAGMA data_version').get() as {data_version:number};
    const local=this.statement('SELECT total_changes() AS changes').get() as {changes:number};
    return `${external.data_version}:${local.changes}:${this.readEpoch}:${(this.client as DatabaseSync & {cacheEpoch?:number}).cacheEpoch || 0}`;
  }
  explain<T>(value: Compilable<T> | CompiledQuery<T>) { const q=this.compiled(value);return this.client.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.parameters as SQLInputValue[]); }
  transaction<T>(fn:()=>T):T {
    // Savepoints allow nested imports, maintenance and application writes.
    this.client.exec('SAVEPOINT atlas_repository_transaction');
    try { const value=fn();this.client.exec('RELEASE SAVEPOINT atlas_repository_transaction');return value; }
    catch(error) { this.client.exec('ROLLBACK TO SAVEPOINT atlas_repository_transaction; RELEASE SAVEPOINT atlas_repository_transaction');throw error; }
    finally { this.readEpoch++; }
  }
  private assertTable(table:RecordTable) { if(!(recordTables as readonly string[]).includes(table))throw new Error('Unknown record table'); }
  getRecord<T=any>(table:RecordTable,id:string):T|undefined { this.assertTable(table);const row=this.one(this.query.selectFrom(table).select('data').where('id','=',id));return row?JSON.parse(row.data):undefined; }
  records<T=any>(table:RecordTable):T[] { this.assertTable(table);return this.all(this.query.selectFrom(table).select('data')).map(row=>JSON.parse(row.data)); }
  putRecord(table:RecordTable,id:string,data:unknown) { this.assertTable(table);const row={id,data:JSON.stringify(data)};this.run(this.query.insertInto(table).values(row).onConflict(c=>c.column('id').doUpdateSet({data:row.data}))); }
  deleteRecord(table:RecordTable,id:string) { this.assertTable(table);this.run(this.query.deleteFrom(table).where('id','=',id)); }
  hasTable(table:string):boolean { return Boolean(this.client.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
  logicalBytes(column:string){return sql<number>`length(cast(${sql.ref(column)} as blob))`;}
  recordFingerprint(column:string){return sql<string>`atlas_record_fingerprint(${sql.ref(column)})`;}
  storageHealth(integrity=false){
    const number=(pragma:string)=>Number(Object.values(this.client.prepare(pragma).get()||{})[0]||0);
    const pageSize=number('PRAGMA page_size'),pages=number('PRAGMA page_count'),free=number('PRAGMA freelist_count');
    return {databaseBytes:pages*pageSize,freeBytes:free*pageSize,pageSize,...(integrity?{integrity:this.client.prepare('PRAGMA quick_check(1)').all().flatMap(row=>Object.values(row).map(String))}:{})};
  }
  compact() { this.client.exec('VACUUM'); }
  backupTo(path:string) { return backup(this.client,path); }
  snapshotTo(path:string) { this.client.prepare('VACUUM INTO ?').run(path); }
  close() { this.statements.clear(); this.client.close(); }
  /** Diagnostic compatibility for tests/offline maintenance, never services. */
  prepare(value:string) { return this.client.prepare(value); }
  exec(value:string) { this.client.exec(value); }
}
