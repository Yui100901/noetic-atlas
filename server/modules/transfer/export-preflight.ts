import type { DataPackageExportInput } from '../../../shared/models/export-preflight.js';
import { exportBudget } from '../../../shared/packages/export-budget.js';
import { estimatedQuestionHashesBytes } from '../../../shared/packages/question-hashes.js';
import { type Store, type Table, tables } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { learningShareSource, selectedPaperIds } from '../sharing/selection.js';
import { shareFilters } from '../sharing/service.js';
import { projectionSources, type ProjectionSource } from '../../database/projections.js';
import { packageExportSchema } from './package-schema.js';

/** Read byte lengths and identities in SQL, never materialize exported bodies
 * or binary attachments merely to find out that the result cannot fit. */
export function contentExportBudget(
  store: Store,
  ids: string[],
  options: {
    paperId?: string;
    paperIds?: string[];
    questionCount?: number;
    sourceRecords?: Array<{ table: Table; ids: string[] }>;
    fullTaxonomy?: boolean;
    multiplicity?: number;
    split?: boolean;
    questionBytes?: number;
    minPayloads?: number;
  } = {},
) {
  const db = store.database,
    q = db.query,
    x = db.expressions;
  const sources: ProjectionSource[] = [
    'questions',
    'papers',
    ...(options.sourceRecords || []).flatMap((source) =>
      projectionSources.includes(source.table as ProjectionSource)
        ? [source.table as ProjectionSource]
        : [],
    ),
  ];
  db.projections.ensure([...new Set(sources)]);
  const stats = (table: Table, selected?: string[]) => {
    let query = q
      .selectFrom(table)
      .select((eb) => [
        eb.fn.sum<number>(db.logicalBytes('data')).as('bytes'),
        eb.fn.max<number>(db.logicalBytes('data')).as('largest'),
      ]);
    if (selected) query = query.where(x.idInJson('id', selected));
    const row = db.one(query)!;
    return { bytes: Number(row.bytes || 0), largest: Number(row.largest || 0) };
  };
  const paperIds = options.paperIds || (options.paperId ? [options.paperId] : []);
  const question = stats('questions', ids),
    paper = paperIds.length ? stats('papers', paperIds) : { bytes: 0, largest: 0 };
  const sourceStats = (options.sourceRecords || []).map((source) =>
    stats(source.table, source.ids),
  );
  const sourceBytes = sourceStats.reduce((sum, row) => sum + row.bytes, 0);
  const metadata = ids.length
    ? db
        .all(
          q
            .selectFrom('questions')
            .select([
              x.field<string>('data', 'categoryIds').as('categories'),
              x.field<string>('data', 'tagIds').as('tags'),
            ])
            .where(x.idInJson('id', ids)),
        )
        .map((row) => ({
          categoryIds: JSON.parse(row.categories || '[]') as string[],
          tagIds: JSON.parse(row.tags || '[]') as string[],
        }))
    : [];
  const categories = new Set(metadata.flatMap((row) => row.categoryIds)),
    tags = new Set(metadata.flatMap((row) => row.tagIds));
  const allCategories = new Map(store.all<any>('categories').map((row) => [row.id, row]));
  const domains = new Set<string>();
  for (const id of categories) {
    const row = allCategories.get(id);
    if (!row) continue;
    domains.add(row.domainId);
    if (row.parentId) categories.add(row.parentId);
  }
  let taxonomyBytes =
    stats('categories', [...categories]).bytes +
    stats('tags', [...tags]).bytes +
    stats('domains', [...domains]).bytes;
  if (paperIds.length || options.fullTaxonomy)
    taxonomyBytes = stats('domains').bytes + stats('categories').bytes + stats('tags').bytes;
  const refs = q
    .selectFrom('asset_references')
    .select('asset_id')
    .where((eb) =>
      eb.or([
        eb.and([eb('source_table', '=', 'questions'), x.idInJson('source_id', ids)]),
        ...(paperIds.length
          ? [eb.and([eb('source_table', '=', 'papers'), x.idInJson('source_id', paperIds)])]
          : []),
        ...(options.sourceRecords || []).map((source) =>
          eb.and([eb('source_table', '=', source.table), x.idInJson('source_id', source.ids)]),
        ),
      ]),
    );
  const assets = db.all(
    q
      .selectFrom('assets')
      .select((eb) => [
        'id',
        eb.fn<number>('length', [x.field<string>('data', 'dataBase64')]).as('encoded'),
        db.logicalBytes('data').as('recordBytes'),
      ])
      .where('id', 'in', refs),
  );
  const attachmentBytes = assets.reduce(
    (sum, row) => sum + Math.ceil((Number(row.encoded || 0) * 3) / 4),
    0,
  );
  const assetMetadata = assets.reduce(
    (sum, row) => sum + Number(row.recordBytes) - Number(row.encoded || 0) + 256,
    0,
  );
  const multiplier = options.multiplicity || 1;
  // Cleaning, frozen/current card resolution and detached references can add
  // fields. Reserve space conservatively rather than assume a ZIP ratio.
  const jsonBytes =
    Math.ceil(
      ((options.questionBytes ?? question.bytes) +
        paper.bytes +
        sourceBytes +
        (taxonomyBytes + assetMetadata) * multiplier) *
        2,
    ) + 8192;
  const payloadCount = options.split
    ? Math.max(
        options.minPayloads || 1,
        Math.ceil(ids.length / 500),
        Math.ceil(jsonBytes / (8 * 1024 * 1024)),
      )
    : 1;
  const largestPayload = options.split
    ? Math.min(
        jsonBytes,
        Math.max(16 * 1024 * 1024, question.largest * 2 + taxonomyBytes * 2 + 8192),
      )
    : jsonBytes;
  const hashBytes = estimatedQuestionHashesBytes(
    (options.questionCount ?? ids.length) * multiplier,
    payloadCount,
  );
  return exportBudget({
    questionCount: options.questionCount ?? ids.length,
    jsonBytes: jsonBytes + hashBytes,
    attachmentBytes,
    largestFileBytes: Math.max(
      largestPayload,
      hashBytes,
      assets.reduce((max, row) => Math.max(max, Math.ceil((Number(row.encoded || 0) * 3) / 4)), 0),
    ),
    fileCount: payloadCount + assets.length + 3 + (hashBytes ? 1 : 0),
    payloadCount,
  });
}

export function previewPackageExport(store: Store, raw: unknown) {
  const input = parse(packageExportSchema, raw) as DataPackageExportInput;
  const db = store.database,
    q = db.query;
  if (input.kind === 'migration') {
    let jsonBytes = 8192,
      largest = 0,
      count = 0;
    for (const table of tables.filter(
      (table) => table !== 'assets' && table !== 'question_banks',
    )) {
      const row = db.one(
        q
          .selectFrom(table)
          .select((eb) => [
            eb.fn.sum<number>(db.logicalBytes('data')).as('bytes'),
            eb.fn.max<number>(db.logicalBytes('data')).as('largest'),
            eb.fn.countAll<number>().as('count'),
          ]),
      )!;
      jsonBytes += Number(row.bytes || 0) * 2;
      largest = Math.max(largest, Number(row.largest || 0) * 2);
      if (table === 'questions') count = Number(row.count);
    }
    const assets = db.all(
      q
        .selectFrom('assets')
        .select((eb) => [
          eb
            .fn<number>('length', [db.expressions.field<string>('data', 'dataBase64')])
            .as('encoded'),
          db.logicalBytes('data').as('bytes'),
        ]),
    );
    const attachmentBytes = assets.reduce(
      (sum, row) => sum + Math.ceil((Number(row.encoded || 0) * 3) / 4),
      0,
    );
    jsonBytes += assets.reduce(
      (sum, row) => sum + (Number(row.bytes) - Number(row.encoded || 0) + 256) * 2,
      0,
    );
    const parts = Math.max(1, Math.ceil(jsonBytes / (8 * 1024 * 1024)) + 1);
    const hashBytes = estimatedQuestionHashesBytes(count, parts);
    return exportBudget(
      {
        questionCount: count,
        jsonBytes: jsonBytes + hashBytes,
        attachmentBytes,
        largestFileBytes: Math.max(
          largest,
          hashBytes,
          assets.reduce(
            (max, row) => Math.max(max, Math.ceil((Number(row.encoded || 0) * 3) / 4)),
            0,
          ),
        ),
        fileCount: parts + assets.length + 3 + (hashBytes ? 1 : 0),
        payloadCount: parts,
      },
      'backup',
    );
  }
  if (input.kind === 'share') {
    const selection =
      input.selection || fail(400, 'PACKAGE_SELECTION_REQUIRED', '请选择需要分享的内容');
    if (selection.kind === 'paper') {
      const paperIds = selectedPaperIds(store, selection);
      const rows = db.all(
        q
          .selectFrom('papers')
          .select('id')
          .select(db.expressions.field<string>('data', 'questionIds').as('ids'))
          .where(db.expressions.idInJson('id', paperIds)),
      );
      if (rows.length !== paperIds.length) fail(404, 'NOT_FOUND', '所选题集不存在，请刷新列表');
      const ids = [...new Set(rows.flatMap((row) => JSON.parse(row.ids || '[]') as string[]))];
      const snapshotCount = rows.reduce(
        (sum, row) => sum + (JSON.parse(row.ids || '[]') as string[]).length,
        0,
      );
      return contentExportBudget(store, ids, { paperIds, questionCount: snapshotCount });
    }
    if (selection.kind === 'learning') {
      const source = learningShareSource(store, selection.learning!, selection.filters);
      const roots = [...new Set(source.items.map((item) => item.sourceId))],
        attempts = [
          ...new Set(source.items.flatMap((item) => (item.attemptId ? [item.attemptId] : []))),
        ];
      const histories = attempts.length
        ? db
            .all(
              q
                .selectFrom('question_history')
                .select('id')
                .where(
                  db.expressions.valueInJson(
                    db.expressions.field<string>('data', 'attemptId'),
                    attempts,
                  ),
                ),
            )
            .map((row) => row.id)
        : [];
      return contentExportBudget(store, roots, {
        questionCount: source.items.length,
        paperIds: source.paperIds,
        sourceRecords: [
          { table: 'attempts', ids: attempts },
          { table: 'learning_results', ids: attempts },
          { table: 'question_history', ids: histories },
        ],
        fullTaxonomy: true,
      });
    }
    const ids = selection.id
      ? [selection.id]
      : selection.ids?.length
        ? selection.ids
        : store.questionMetadata(shareFilters(selection.filters)).map((row) => row.id);
    return contentExportBudget(store, ids);
  }
  if (input.kind === 'question-update') return contentExportBudget(store, input.ids || []);
  let metadataBytes = 0;
  for (const table of input.kind === 'question-template'
    ? (['domains', 'categories', 'tags'] as const)
    : (['settings'] as const)) {
    metadataBytes += Number(
      db.one(
        q.selectFrom(table).select((eb) => eb.fn.sum<number>(db.logicalBytes('data')).as('bytes')),
      )!.bytes || 0,
    );
  }
  const jsonBytes = metadataBytes * 2 + (input.kind === 'question-template' ? 256000 : 65536);
  return exportBudget({
    questionCount: 0,
    jsonBytes,
    attachmentBytes: 0,
    largestFileBytes: jsonBytes,
    fileCount: 2,
    payloadCount: 1,
  });
}

export function assertExportAllowed(preflight: ReturnType<typeof previewPackageExport>) {
  if (!preflight.allowed)
    fail(
      422,
      'EXPORT_PREFLIGHT_BLOCKED',
      preflight.reasons.join(' ') + ' 请使用下方建议的导出方式。',
      preflight,
    );
}
