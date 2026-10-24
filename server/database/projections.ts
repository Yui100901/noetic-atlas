import type { DatabaseConnection } from './connection.js';
import { collectAssetReferences } from '../../shared/assets/asset-references.js';

export const projectionSources=['questions','documents','papers','attempts','study','reviews'] as const;
export type ProjectionSource=typeof projectionSources[number];
const questionFields=['id','title','status','collection','type','difficulty','depth','frequency','categoryIds','tagIds'] as const;
const searchFields=['id','title','stemMarkdown','answerMarkdown','explanationMarkdown'] as const;

/** Disposable, versioned read projections. Original entities/snapshots remain
 * authoritative. Bound writes and DB-side dirty markers keep CLI/other-connection
 * imports, deleted rows, nested rollbacks and WASM restores coherent. */
export class RecordProjections {
  constructor(private readonly database:DatabaseConnection) {}
  initialize() {
    const d=this.database,q=d.query;
    const complete=['question_read_model','paper_read_model','projection_pending','asset_references'].every(table=>d.hasTable(table));
    d.transaction(()=>{
      d.run(q.schema.createTable('question_read_model').ifNotExists().addColumn('id','text',c=>c.primaryKey()).addColumn('data','text',c=>c.notNull()).addColumn('search_text','text',c=>c.notNull()).addColumn('title_key','text',c=>c.notNull()));
      d.run(q.schema.createTable('paper_read_model').ifNotExists().addColumn('id','text',c=>c.primaryKey()).addColumn('data','text',c=>c.notNull()));
      d.run(q.schema.createTable('projection_pending').ifNotExists().addColumn('source_table','text',c=>c.notNull()).addColumn('source_id','text',c=>c.notNull()).addPrimaryKeyConstraint('projection_pending_pk',['source_table','source_id']));
      d.run(q.schema.createTable('asset_references').ifNotExists().addColumn('source_table','text',c=>c.notNull()).addColumn('source_id','text',c=>c.notNull()).addColumn('asset_id','text',c=>c.notNull()).addPrimaryKeyConstraint('asset_references_pk',['source_table','source_id','asset_id']));
      d.run(q.schema.createIndex('asset_references_asset_idx').ifNotExists().on('asset_references').column('asset_id'));
      d.run(q.schema.createIndex('question_read_title_idx').ifNotExists().on('question_read_model').column('title_key'));
      d.run(q.schema.createIndex('paper_read_updated_idx').ifNotExists().on('paper_read_model').expression(d.expressions.field('data','updatedAt')));
      // Trigger DDL is SQLite-specific; only fixed, code-owned names occur here.
      for(const table of projectionSources) {
        // Avoid unique conflicts rather than relying on OR IGNORE: an outer
        // entity UPSERT can override a trigger's SQLite conflict policy.
        const mark=(row:'old'|'new')=>`INSERT INTO projection_pending(source_table,source_id) SELECT '${table}',${row}.id WHERE NOT EXISTS(SELECT 1 FROM projection_pending WHERE source_table='${table}' AND source_id=${row}.id);`;
        d.maintenance.exec(`
          CREATE TRIGGER IF NOT EXISTS atlas_projection_${table}_insert AFTER INSERT ON ${table} BEGIN ${mark('new')} END;
          CREATE TRIGGER IF NOT EXISTS atlas_projection_${table}_update AFTER UPDATE ON ${table} BEGIN ${mark('old')} ${mark('new')} END;
          CREATE TRIGGER IF NOT EXISTS atlas_projection_${table}_delete AFTER DELETE ON ${table} BEGIN ${mark('old')} END;
        `);
      }
      const version=d.one(q.selectFrom('metadata').select('value').where('key','=','read_projection_version'))?.value;
      if(version!=='2'||!complete) {
        d.run(q.deleteFrom('question_read_model'));d.run(q.deleteFrom('paper_read_model'));d.run(q.deleteFrom('asset_references'));
        for(const table of projectionSources)d.run(q.insertInto('projection_pending').columns(['source_table','source_id']).expression(eb=>eb.selectFrom(table).select([eb.val(table).as('source_table'),'id as source_id']).where('id','is not',null)).onConflict(c=>c.columns(['source_table','source_id']).doNothing()));
        d.run(q.insertInto('metadata').values({key:'read_projection_version',value:'2'}).onConflict(c=>c.column('key').doUpdateSet({value:'2'})));
      }
    });
  }
  ensure(sources:readonly ProjectionSource[]) {
    if(!sources.length)return;
    const d=this.database,q=d.query;
    // Fast path makes ordinary reads one tiny queue lookup, no cache TTL and
    // no stale-content window after edits or imports in another connection.
    if(!d.one(q.selectFrom('projection_pending').select('source_id').where('source_table','in',sources).limit(1)))return;
    d.transaction(()=>{
      for(const source of sources){
        while(true){
          const pending=d.all(q.selectFrom('projection_pending').select('source_id').where('source_table','=',source).limit(200));
          if(!pending.length)break;
          const ids=pending.map(row=>row.source_id);
          const records=new Map(d.all(q.selectFrom(source).select(['id','data']).where('id','in',ids)).map(row=>[row.id,JSON.parse(row.data)]));
          // Asset relations are exact structural references; Markdown substrings
          // and dataBase64 contents cannot create false delete protection.
          d.run(q.deleteFrom('asset_references').where('source_table','=',source).where('source_id','in',ids));
          const refs:Array<{source_table:string;source_id:string;asset_id:string}>=[];
          for(const id of ids){
            const record=records.get(id);
            if(!record){
              if(source==='questions')d.run(q.deleteFrom('question_read_model').where('id','=',id));
              if(source==='papers')d.run(q.deleteFrom('paper_read_model').where('id','=',id));
              continue;
            }
            for(const assetId of collectAssetReferences(record))refs.push({source_table:source,source_id:id,asset_id:assetId});
            if(source==='questions'){
              const metadata=Object.fromEntries(questionFields.filter(key=>Object.hasOwn(record,key)).map(key=>[key,record[key]]));
              const row={id,data:JSON.stringify(metadata),search_text:searchFields.map(key=>String(record[key])).join(' ').toLowerCase(),title_key:String(record.title??'').normalize('NFKC').trim().toLowerCase()};
              d.run(q.insertInto('question_read_model').values(row).onConflict(c=>c.column('id').doUpdateSet({data:row.data,search_text:row.search_text,title_key:row.title_key})));
            }
            if(source==='papers'){
              // Retain every scoring input, including group part weights/types,
              // so list views still reject invalid snapshots through normalizeScoring.
              const snapshot=Array.isArray(record.snapshot)?record.snapshot.map((question:any)=>({id:question.id,type:question.type,...(question.sourceQuestionId?{sourceQuestionId:question.sourceQuestionId}:{}),...(question.groupId?{groupId:question.groupId}:{}),...(Array.isArray(question.parts)?{parts:question.parts.map((part:any)=>({id:part.id,type:part.type,...(part.weight!==undefined?{weight:part.weight}:{})}))}:{})})):record.snapshot;
              const data=JSON.stringify({...record,snapshot});
              d.run(q.insertInto('paper_read_model').values({id,data}).onConflict(c=>c.column('id').doUpdateSet({data})));
            }
          }
          for(let offset=0;offset<refs.length;offset+=100)d.run(q.insertInto('asset_references').values(refs.slice(offset,offset+100)).onConflict(c=>c.columns(['source_table','source_id','asset_id']).doNothing()));
          d.run(q.deleteFrom('projection_pending').where('source_table','=',source).where('source_id','in',ids));
        }
      }
    });
  }
  refreshAll() { this.ensure(projectionSources); }
  rebuild() {
    this.database.run(this.database.query.deleteFrom('metadata').where('key','=','read_projection_version'));
    this.initialize();this.refreshAll();
  }
}
