import { createHash } from 'node:crypto';
import type {
  SQLiteMigrationPreview,
  SQLiteMigrationSelection,
} from '../../../shared/models/sqlite-migration.js';
import type { Store } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { recordTables, type RecordTable } from '../../database/schema.js';
import { collectAssetReferences } from '../../../shared/assets/asset-references.js';

interface Reference {
  key: string;
  path: string;
  value: string;
}
interface GraphRow {
  id: string;
  digest: string;
  refs: Reference[];
}
export interface SQLiteMigrationPlan {
  preview: SQLiteMigrationPreview;
  retained: Map<RecordTable, Set<string>>;
}
const permanent = new Set<RecordTable>([
  'domains',
  'categories',
  'tags',
  'settings',
  'ai_settings',
]);
const root = (id: string) => id.split('::')[0]!;
const parentKey = (ref: Reference) =>
  ref.path
    .split('.')
    .at(-1)
    ?.replace(/\[\d+\]$/, '') || '';
const questionRefs = (row: GraphRow) =>
  row.refs
    .filter(
      (ref) =>
        ['questionId', 'sourceQuestionId', 'groupId'].includes(ref.key) ||
        [
          'questionIds',
          'ids',
          'importedQuestionIds',
          'correctedQuestionIds',
          'previewQuestionIds',
        ].includes(parentKey(ref)) ||
        (ref.key === 'id' &&
          /(?:\.(?:questions|snapshot|items|candidates)\[\d+\]|\.question)$/.test(ref.path)),
    )
    .map((ref) => root(ref.value));
const values = (row: GraphRow, keys: string[]) =>
  row.refs
    .filter((ref) => keys.includes(ref.key) || keys.includes(parentKey(ref)))
    .map((ref) => ref.value);
const intersects = (values: string[], ids: Set<string>) => values.some((value) => ids.has(value));
const cache = new WeakMap<Store, { version: string; plans: Map<string, SQLiteMigrationPlan> }>();

/** Seed relevant sessions once, then follow their dependencies forward. A mixed
 * paper/day is indivisible: answers, scores and FSRS chains are never rewritten.
 * Dependency questions do not pull in every unrelated paper that uses them. */
export function sqliteMigrationPlan(
  store: Store,
  selection: SQLiteMigrationSelection,
): SQLiteMigrationPlan {
  const db = store.database,
    domainIds = [...new Set(selection.domainIds || [])].sort();
  for (const domainId of domainIds)
    if (!store.get('domains', domainId))
      fail(400, 'MIGRATION_DOMAIN_NOT_FOUND', `迁移领域不存在：${domainId}`);
  const version = db.readVersion(),
    key = JSON.stringify(domainIds),
    saved = cache.get(store);
  if (saved?.version === version && saved.plans.has(key)) return saved.plans.get(key)!;
  const graph = new Map<RecordTable, GraphRow[]>(),
    retained = new Map<RecordTable, Set<string>>();
  const hash = createHash('sha256').update(key);
  for (const table of recordTables) {
    const rows = db.all(
      db.query
        .selectFrom(table)
        .select('id')
        .select(db.recordFingerprint('data').as('digest'))
        .select(
          domainIds.length && !permanent.has(table) && table !== 'assets'
            ? db.expressions.migrationReferences('data').as('refs')
            : db.expressions.field<string>('data', 'unusedMigrationReferences').as('refs'),
        )
        .orderBy('id'),
    );
    graph.set(
      table,
      rows.map((row) => {
        hash.update(JSON.stringify([table, row.id, row.digest]));
        return { id: row.id, digest: row.digest, refs: row.refs ? JSON.parse(row.refs) : [] };
      }),
    );
    retained.set(table, new Set());
  }
  const existing = new Map(
    recordTables.map((table) => [table, new Set(graph.get(table)!.map((row) => row.id))]),
  );
  const keep = (table: RecordTable, id: string) => {
    if (!existing.get(table)!.has(id)) return false;
    const set = retained.get(table)!;
    if (set.has(id)) return false;
    set.add(id);
    return true;
  };
  const keepRows = (table: RecordTable, predicate: (row: GraphRow) => boolean) => {
    for (const row of graph.get(table)!) if (predicate(row)) retained.get(table)!.add(row.id);
  };
  const set = (table: RecordTable) => retained.get(table)!;
  const selectedDomains = new Set(domainIds);
  const byDomain = (row: GraphRow) =>
    intersects(values(row, ['domainId', 'domainIds']), selectedDomains) ||
    intersects(values(row, ['categoryId', 'categoryIds']), categoryIds);
  const categoryIds = new Set(
    store
      .all<any>('categories')
      .filter((category) => domainIds.includes(category.domainId))
      .map((category) => category.id),
  );
  const seed = new Set<string>();
  if (!domainIds.length) {
    for (const table of recordTables) keepRows(table, () => true);
    for (const row of graph.get('questions')!) seed.add(row.id);
  } else {
    for (const table of permanent) keepRows(table, () => true);
    keepRows('questions', (row) => byDomain(row));
    for (const id of set('questions')) seed.add(id);
    keepRows('documents', byDomain);
    keepRows('papers', (row) => byDomain(row) || intersects(questionRefs(row), seed));
    const seedPapers = new Set(set('papers'));
    for (const table of [
      'attempts',
      'learning_results',
      'focus_sessions',
      'learning_days',
      'daily_pushes',
      'paper_drafts',
      'document_drafts',
      'question_drafts',
      'question_revisions',
      'ai_import_jobs',
    ] as const)
      keepRows(
        table,
        (row) =>
          byDomain(row) ||
          intersects(questionRefs(row), seed) ||
          intersects(values(row, ['paperId']), seedPapers) ||
          intersects(values(row, ['documentId']), set('documents')),
      );
    // A history row can own the only surviving detailed response. Select these
    // by the requested roots; ordinary reviews may outlive removed attempts.
    keepRows('question_history', (row) => byDomain(row) || intersects(questionRefs(row), seed));
    keepRows(
      'ai_runs',
      (row) =>
        byDomain(row) ||
        intersects(questionRefs(row), seed) ||
        intersects(values(row, ['attemptId']), set('attempts')) ||
        intersects(values(row, ['jobId']), set('ai_import_jobs')),
    );
    keepRows(
      'ai_workspace_drafts',
      (row) =>
        byDomain(row) ||
        intersects(questionRefs(row), seed) ||
        intersects(values(row, ['contextId', 'jobId']), set('ai_import_jobs')),
    );

    const edgeTables: Record<string, RecordTable> = {
      paperId: 'papers',
      createdPaperId: 'papers',
      attemptId: 'attempts',
      focusSessionId: 'focus_sessions',
      learningDayId: 'learning_days',
      dayId: 'learning_days',
      documentId: 'documents',
      cardId: 'review_cards',
      feedbackId: 'question_feedback',
      feedbackIds: 'question_feedback',
      jobId: 'ai_import_jobs',
      scanId: 'quality_scans',
    };
    const documentVersions = new Map<string, string[]>();
    for (const row of graph.get('document_versions')!)
      for (const version of values(row, ['versionId']))
        documentVersions.set(version, [...(documentVersions.get(version) || []), row.id]);
    let changed = true;
    // A retained snapshot can outlive both its bank root and the whole attempt.
    // Track those identities separately from live-question export counts, so
    // their independent evidence and memory chains remain a complete unit.
    const historicalRoots = new Set(seed);
    while (changed) {
      changed = false;
      const add = (table: RecordTable, id: string) => {
        changed = keep(table, id) || changed;
      };
      for (const table of recordTables)
        for (const row of graph.get(table)!) {
          if (!set(table).has(row.id)) continue;
          // AI output candidate lists and quality comparisons are historical
          // evidence, not ownership of every candidate's current bank content.
          if (
            !permanent.has(table) &&
            ![
              'ai_runs',
              'ai_import_jobs',
              'ai_workspace_drafts',
              'quality_issues',
              'quality_scans',
              'question_feedback',
            ].includes(table)
          )
            for (const id of questionRefs(row)) {
              historicalRoots.add(id);
              add('questions', id);
            }
          if (table === 'attempts') add('learning_results', row.id);
          if (table === 'learning_results') add('attempts', row.id);
          for (const ref of row.refs) {
            const target = edgeTables[ref.key] || edgeTables[parentKey(ref)];
            // Review events deliberately retain their provenance after whole
            // histories expire; requiring all old attempts defeats scope limits.
            if (target && !(target === 'attempts' && ['reviews', 'review_events'].includes(table)))
              add(target, ref.value);
            if (table === 'question_history' && ref.key === 'attemptId')
              add('learning_results', ref.value);
            if (ref.key === 'versionId')
              for (const versionId of documentVersions.get(ref.value) || [])
                add('document_versions', versionId);
            if (ref.key === 'contextId' && table === 'ai_workspace_drafts')
              add('ai_import_jobs', ref.value);
            if (ref.key === 'context' && table === 'paper_drafts') add('papers', ref.value);
          }
        }
      // Complete, ordered memory chains travel together. Study state is useful
      // for necessary cross-domain questions too, without selecting their other
      // papers or extending the migration to all learning sessions.
      for (const table of [
        'study',
        'study_parts',
        'reviews',
        'review_cards',
        'review_events',
        'question_feedback',
        'quality_issues',
        'question_drafts',
        'question_revisions',
      ] as const)
        for (const row of graph.get(table)!)
          if (intersects(questionRefs(row), historicalRoots)) add(table, row.id);
      for (const row of graph.get('document_versions')!)
        if (intersects(values(row, ['documentId']), set('documents')))
          add('document_versions', row.id);
      for (const row of graph.get('document_drafts')!)
        if (intersects(values(row, ['documentId']), set('documents')))
          add('document_drafts', row.id);
      for (const row of graph.get('paper_drafts')!)
        if (intersects(values(row, ['context']), set('papers'))) add('paper_drafts', row.id);
      for (const row of graph.get('question_history')!)
        if (intersects(values(row, ['attemptId']), set('attempts')))
          add('question_history', row.id);
      for (const row of graph.get('learning_task_results')!)
        if (intersects(values(row, ['dayId']), set('learning_days')))
          add('learning_task_results', row.id);
      for (const row of graph.get('daily_pushes')!)
        if (intersects(values(row, ['paperId']), set('papers'))) add('daily_pushes', row.id);
      for (const row of graph.get('ai_runs')!)
        if (
          intersects(values(row, ['jobId']), set('ai_import_jobs')) ||
          intersects(values(row, ['attemptId']), set('attempts'))
        )
          add('ai_runs', row.id);
      for (const row of graph.get('ai_workspace_drafts')!)
        if (intersects(values(row, ['contextId']), set('ai_import_jobs')))
          add('ai_workspace_drafts', row.id);
    }
    // Exact managed file references are read only from retained owners. This
    // includes raw AI drafts, which are not part of normal asset projections.
    for (const table of recordTables) {
      if (table === 'assets' || !set(table).size) continue;
      for (const row of db.all(
        db.query
          .selectFrom(table)
          .select('data')
          .where(db.expressions.idInJson('id', [...set(table)])),
      ))
        for (const id of collectAssetReferences(JSON.parse(row.data))) keep('assets', id);
    }
  }
  const counts = Object.fromEntries(
    recordTables.map((table) => [table, table === 'quality_fingerprints' ? 0 : set(table).size]),
  );
  const warnings = domainIds.length
    ? [
        '保留所选领域相关的完整题集、整次作答、学习日计划及其必要依赖；跨领域记录不会拆分或重算分数。',
        '系统配置和分类标签结构一并保留；领域迁移副本关闭每日自动推题，AI密钥不随数据库导出。',
        '没有领域、题目或教材关联的独立AI任务与未归类草稿仅在整体迁移中保留。',
      ]
    : ['包含全部内容、附件、学习状态、历史作答、草稿和AI处理记录；AI密钥不随数据库导出。'];
  const preview: SQLiteMigrationPreview = {
    scope: domainIds.length ? 'domains' : 'all',
    domainIds,
    fingerprint: hash.digest('hex'),
    counts,
    seedQuestions: seed.size,
    dependencyQuestions: Math.max(0, set('questions').size - seed.size),
    warnings,
  };
  const plan = { preview, retained };
  const plans = saved?.version === version ? saved.plans : new Map<string, SQLiteMigrationPlan>();
  if (plans.size >= 8) plans.delete(plans.keys().next().value!);
  plans.set(key, plan);
  cache.set(store, { version, plans });
  return plan;
}
