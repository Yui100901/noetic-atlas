import type { DatabaseConnection } from './connection.js';
import type { QuestionInput } from '../../shared/models/types.js';
import {
  importDigest,
  importQuestionContent,
  importQuestionFeatures,
} from '../../shared/questions/import-dedup.js';
import { base64ToBytes } from '../../shared/assets/assets.js';
import { sha256 } from '@noble/hashes/sha2.js';

export interface ImportIndexRow {
  id: string;
  content_hash: string;
  prompt_hash: string;
  title: string;
  title_key: string;
  vocab_key: string;
  type: string;
  status: string;
  source_stamp: string;
  tokens: string;
}
export class ImportProjections {
  constructor(private readonly db: DatabaseConnection) {}
  initialize() {
    const d = this.db,
      q = d.query,
      complete = [
        'question_import_index',
        'question_import_terms',
        'question_import_pending',
      ].every((table) => d.hasTable(table));
    d.transaction(() => {
      d.run(
        q.schema
          .createTable('question_import_index')
          .ifNotExists()
          .addColumn('id', 'text', (c) => c.primaryKey())
          .addColumn('content_hash', 'text', (c) => c.notNull())
          .addColumn('prompt_hash', 'text', (c) => c.notNull())
          .addColumn('title', 'text', (c) => c.notNull())
          .addColumn('title_key', 'text', (c) => c.notNull())
          .addColumn('vocab_key', 'text', (c) => c.notNull())
          .addColumn('type', 'text', (c) => c.notNull())
          .addColumn('status', 'text', (c) => c.notNull())
          .addColumn('source_stamp', 'text', (c) => c.notNull())
          .addColumn('tokens', 'text', (c) => c.notNull()),
      );
      d.run(
        q.schema
          .createTable('question_import_terms')
          .ifNotExists()
          .addColumn('term', 'text', (c) => c.notNull())
          .addColumn('question_id', 'text', (c) => c.notNull())
          .addPrimaryKeyConstraint('question_import_terms_pk', ['term', 'question_id']),
      );
      d.run(
        q.schema
          .createIndex('question_import_terms_question_idx')
          .ifNotExists()
          .on('question_import_terms')
          .column('question_id'),
      );
      d.run(
        q.schema
          .createTable('question_import_pending')
          .ifNotExists()
          .addColumn('source_table', 'text', (c) => c.notNull())
          .addColumn('source_id', 'text', (c) => c.notNull())
          .addPrimaryKeyConstraint('question_import_pending_pk', ['source_table', 'source_id']),
      );
      for (const field of ['content_hash', 'prompt_hash', 'title_key', 'vocab_key'] as const)
        d.run(
          q.schema
            .createIndex(`question_import_${field}_idx`)
            .ifNotExists()
            .on('question_import_index')
            .column(field),
        );
      for (const table of ['questions', 'assets']) {
        const mark = (row: 'old' | 'new') =>
          `INSERT INTO question_import_pending(source_table,source_id) SELECT '${table}',${row}.id WHERE NOT EXISTS(SELECT 1 FROM question_import_pending WHERE source_table='${table}' AND source_id=${row}.id);`;
        d.maintenance.exec(
          `CREATE TRIGGER IF NOT EXISTS atlas_import_${table}_insert AFTER INSERT ON ${table} BEGIN ${mark('new')} END; CREATE TRIGGER IF NOT EXISTS atlas_import_${table}_update AFTER UPDATE ON ${table} BEGIN ${mark('old')} ${mark('new')} END; CREATE TRIGGER IF NOT EXISTS atlas_import_${table}_delete AFTER DELETE ON ${table} BEGIN ${mark('old')} END;`,
        );
      }
      if (
        !complete ||
        d.one(q.selectFrom('metadata').select('value').where('key', '=', 'question_import_version'))
          ?.value !== '1'
      ) {
        d.run(q.deleteFrom('question_import_index'));
        d.run(q.deleteFrom('question_import_terms'));
        d.run(
          q
            .insertInto('question_import_pending')
            .columns(['source_table', 'source_id'])
            .expression((eb) =>
              eb
                .selectFrom('questions')
                .select([eb.val('questions').as('source_table'), 'id as source_id'])
                .where('id', 'is not', null),
            )
            .onConflict((c) => c.columns(['source_table', 'source_id']).doNothing()),
        );
        d.run(
          q
            .insertInto('metadata')
            .values({ key: 'question_import_version', value: '1' })
            .onConflict((c) => c.column('key').doUpdateSet({ value: '1' })),
        );
      }
    });
    return !complete;
  }
  assetResolver(extra: Map<string, any> = new Map()) {
    const cache = new Map<string, string>();
    return (id: string) => {
      if (cache.has(id)) return cache.get(id)!;
      const asset = extra.get(id) || this.db.getRecord<any>('assets', id);
      const key = asset?.dataBase64
        ? `${asset.mimeType || ''}:${Array.from(sha256(base64ToBytes(asset.dataBase64)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
        : `missing:${id}`;
      cache.set(id, key);
      return key;
    };
  }
  ensure() {
    const d = this.db,
      q = d.query;
    if (!d.one(q.selectFrom('question_import_pending').select('source_id').limit(1))) return;
    d.projections.ensure(['questions']);
    d.transaction(() => {
      const assets = d.all(
        q
          .selectFrom('question_import_pending')
          .select('source_id')
          .where('source_table', '=', 'assets'),
      );
      for (let offset = 0; offset < assets.length; offset += 200) {
        const ids = assets.slice(offset, offset + 200).map((row) => row.source_id);
        d.run(
          q
            .insertInto('question_import_pending')
            .columns(['source_table', 'source_id'])
            .expression((eb) =>
              eb
                .selectFrom('asset_references')
                .select([eb.val('questions').as('source_table'), 'source_id'])
                .where('source_table', '=', 'questions')
                .where('asset_id', 'in', ids),
            )
            .onConflict((c) => c.columns(['source_table', 'source_id']).doNothing()),
        );
      }
      d.run(q.deleteFrom('question_import_pending').where('source_table', '=', 'assets'));
      const resolveAsset = this.assetResolver();
      while (true) {
        const pending = d.all(
          q
            .selectFrom('question_import_pending')
            .select('source_id')
            .where('source_table', '=', 'questions')
            .limit(200),
        );
        if (!pending.length) break;
        const ids = pending.map((row) => row.source_id),
          records = d.all(q.selectFrom('questions').select(['id', 'data']).where('id', 'in', ids));
        d.run(q.deleteFrom('question_import_index').where('id', 'in', ids));
        d.run(q.deleteFrom('question_import_terms').where('question_id', 'in', ids));
        const terms: Array<{ term: string; question_id: string }> = [];
        for (const row of records) {
          const question = JSON.parse(row.data) as QuestionInput,
            features = importQuestionFeatures(question);
          d.run(
            q.insertInto('question_import_index').values({
              id: row.id,
              content_hash: importDigest(importQuestionContent(question, resolveAsset)),
              prompt_hash: features.promptHash,
              title: question.title,
              title_key: features.titleKey,
              vocab_key: features.vocabKey,
              type: question.type,
              status: question.status || 'pending',
              source_stamp: (question as any).updatedAt || (question as any).createdAt || '',
              tokens: JSON.stringify(features.tokens),
            }),
          );
          for (const term of features.tokens) terms.push({ term, question_id: row.id });
        }
        for (let offset = 0; offset < terms.length; offset += 300)
          d.run(
            q
              .insertInto('question_import_terms')
              .values(terms.slice(offset, offset + 300))
              .onConflict((c) => c.columns(['term', 'question_id']).doNothing()),
          );
        d.run(
          q
            .deleteFrom('question_import_pending')
            .where('source_table', '=', 'questions')
            .where('source_id', 'in', ids),
        );
      }
    });
  }
}
