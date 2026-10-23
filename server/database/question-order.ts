import { sql } from 'kysely';
import type { DatabaseConnection } from './connection.js';

export const questionIndexes = [
  {name:'question_read_status_id_idx',fields:['status']},
  {name:'question_read_status_collection_type_idx',fields:['status','collection','type']},
  {name:'question_read_status_difficulty_idx',fields:['status','difficulty']},
  {name:'question_read_status_frequency_idx',fields:['status','frequency']},
] as const;

/** SQLite adapter optimization for the existing locale/numeric ID order.
 * Only IDs are sorted in JS and the cache is private TEMP data, so neither
 * database migration nor backups depend on a platform-specific collation. */
export class QuestionOrder {
  private readonly collator=new Intl.Collator(undefined,{numeric:true});
  private dataVersion=-1;
  constructor(private readonly database:DatabaseConnection){
    for(const index of questionIndexes)database.run(database.query.schema.createIndex(index.name).ifNotExists().on('question_read_model')
      .expression(sql.join([...index.fields.map(key=>database.expressions.field('data',key)),sql.ref('id')])));
    this.initialize();
  }
  private initialize(){
    this.database.maintenance.exec(`
      CREATE TEMP TABLE IF NOT EXISTS atlas_question_order(id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS temp.atlas_question_order_rank ON atlas_question_order(ordinal);
      CREATE TEMP TABLE IF NOT EXISTS atlas_question_order_state(dirty INTEGER NOT NULL);
      INSERT INTO atlas_question_order_state SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM atlas_question_order_state);
      CREATE TEMP TRIGGER IF NOT EXISTS atlas_question_order_insert AFTER INSERT ON main.questions BEGIN UPDATE atlas_question_order_state SET dirty=1; END;
      CREATE TEMP TRIGGER IF NOT EXISTS atlas_question_order_delete AFTER DELETE ON main.questions BEGIN UPDATE atlas_question_order_state SET dirty=1; END;
      CREATE TEMP TRIGGER IF NOT EXISTS atlas_question_order_id AFTER UPDATE OF id ON main.questions WHEN old.id<>new.id BEGIN UPDATE atlas_question_order_state SET dirty=1; END;
    `);
  }
  ensure(){
    const {maintenance}=this.database;
    // A WASM backup restore replaces the underlying connection, including TEMP
    // tables. External writes invalidate the cache through data_version instead
    // of the connection-local triggers.
    if(!maintenance.prepare("SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='atlas_question_order_state'").get())this.initialize();
    const version=Number((maintenance.prepare('PRAGMA data_version').get() as {data_version:number}).data_version);
    const dirty=(maintenance.prepare('SELECT dirty FROM temp.atlas_question_order_state').get() as {dirty:number}).dirty;
    if(!dirty&&version===this.dataVersion)return;
    const ids=this.database.all(this.database.query.selectFrom('questions as q').select('q.id').orderBy(this.database.expressions.rowOrder('q'))).map(row=>row.id);
    ids.sort(this.collator.compare); // stable ties retain the former rowid order
    maintenance.exec('SAVEPOINT atlas_question_order_refresh');
    try{
      this.database.run(this.database.query.deleteFrom('atlas_question_order'));
      // One bound JSON array avoids per-ID writes and SQLite parameter limits.
      maintenance.prepare('INSERT INTO temp.atlas_question_order(id,ordinal) SELECT value,CAST(key AS INTEGER) FROM json_each(?)').run(JSON.stringify(ids));
      maintenance.exec('UPDATE temp.atlas_question_order_state SET dirty=0; RELEASE SAVEPOINT atlas_question_order_refresh');
      this.dataVersion=version;
    }catch(error){maintenance.exec('ROLLBACK TO SAVEPOINT atlas_question_order_refresh; RELEASE SAVEPOINT atlas_question_order_refresh');throw error;}
  }
}
