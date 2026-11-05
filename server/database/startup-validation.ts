import type { DatabaseConnection } from './connection.js';
import { assetReferenceSources } from './asset-reference-sources.js';

const sources = [...assetReferenceSources, 'domains', 'categories', 'tags', 'assets'] as const;

/** Independent of read projections: refreshing a list must never consume the
 * evidence that an externally changed source still needs startup validation. */
export class StartupValidation {
  constructor(private readonly database: DatabaseConnection) {}

  initialize(): boolean {
    const d = this.database,
      q = d.query;
    const rebuild =
      !d.hasTable('startup_validation_pending') ||
      d.one(
        q.selectFrom('metadata').select('value').where('key', '=', 'startup_validation_version'),
      )?.value !== '1';
    d.transaction(() => {
      d.run(
        q.schema
          .createTable('startup_validation_pending')
          .ifNotExists()
          .addColumn('source_table', 'text', (c) => c.notNull())
          .addColumn('source_id', 'text', (c) => c.notNull())
          .addPrimaryKeyConstraint('startup_validation_pending_pk', ['source_table', 'source_id']),
      );
      // Fixed source names are code-owned. All entity values remain bound.
      for (const table of sources) {
        const mark = (row: 'old' | 'new') =>
          `INSERT INTO startup_validation_pending(source_table,source_id) SELECT '${table}',${row}.id WHERE NOT EXISTS(SELECT 1 FROM startup_validation_pending WHERE source_table='${table}' AND source_id=${row}.id);`;
        d.maintenance
          .exec(`CREATE TRIGGER IF NOT EXISTS atlas_startup_${table}_insert AFTER INSERT ON ${table} BEGIN ${mark('new')} END;
          CREATE TRIGGER IF NOT EXISTS atlas_startup_${table}_update AFTER UPDATE ON ${table} BEGIN ${mark('old')} ${mark('new')} END;
          CREATE TRIGGER IF NOT EXISTS atlas_startup_${table}_delete AFTER DELETE ON ${table} BEGIN ${mark('old')} END;`);
      }
      if (rebuild) {
        for (const table of sources)
          d.run(
            q
              .insertInto('startup_validation_pending')
              .columns(['source_table', 'source_id'])
              .expression((eb) =>
                eb
                  .selectFrom(table)
                  .select([eb.val(table).as('source_table'), 'id as source_id'])
                  .where('id', 'is not', null),
              )
              .onConflict((c) => c.columns(['source_table', 'source_id']).doNothing()),
          );
        d.run(
          q
            .insertInto('metadata')
            .values({ key: 'startup_validation_version', value: '1' })
            .onConflict((c) => c.column('key').doUpdateSet({ value: '1' })),
        );
      }
    });
    return rebuild;
  }

  pending(source?: (typeof sources)[number]): boolean {
    let query = this.database.query
      .selectFrom('startup_validation_pending')
      .select('source_id')
      .limit(1);
    if (source) query = query.where('source_table', '=', source);
    return !!this.database.one(query);
  }

  *ids(source: (typeof sources)[number]): Generator<string[]> {
    let after: string | undefined;
    for (;;) {
      let query = this.database.query
        .selectFrom('startup_validation_pending')
        .select('source_id')
        .where('source_table', '=', source)
        .orderBy('source_id')
        .limit(200);
      if (after !== undefined) query = query.where('source_id', '>', after);
      const rows = this.database.all(query);
      if (!rows.length) return;
      yield rows.map((row) => row.source_id);
      after = rows.at(-1)!.source_id;
    }
  }

  complete() {
    this.database.run(this.database.query.deleteFrom('startup_validation_pending'));
  }
}
