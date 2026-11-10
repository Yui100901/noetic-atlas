import type { Store } from '../../core/store.js';
import { recordTables, type RecordTable } from '../../database/schema.js';
import { importDigest } from '../../../shared/questions/import-dedup.js';
import { collectAssetReferences } from '../../../shared/assets/asset-references.js';
import { isSubjectiveType } from '../../../shared/questions/question-utils.js';
import type { StoredAttempt, StoredPaper } from '../practice/service.js';
import { fail } from '../../core/validation.js';
import { taskCommitKey } from './commit-marker.js';

export { taskCommitKey } from './commit-marker.js';

export interface TaskPatch {
  table: RecordTable;
  id: string;
  before: string | null;
  data?: unknown;
}
export interface TaskChangeSet {
  guards: Array<{ table: RecordTable; ids?: string[]; fingerprint: string }>;
  patches: TaskPatch[];
}
const contentTables: RecordTable[] = [
  'domains',
  'categories',
  'tags',
  'questions',
  'papers',
  'assets',
  'question_revisions',
  'document_versions',
  'documents',
];
function rowFingerprints(store: Store, table: RecordTable, ids?: string[]) {
  const db = store.database;
  if (ids?.length === 0) return [];
  let query = db.query
    .selectFrom(table)
    .select('id')
    .select(db.recordFingerprint('data').as('hash'))
    .orderBy('id');
  if (ids) query = query.where(db.expressions.idInJson('id', ids));
  return db.all(query);
}
const fingerprint = (store: Store, table: RecordTable, ids?: string[]) =>
  importDigest(JSON.stringify(rowFingerprints(store, table, ids)));

function relatedAiAssets(
  store: Store,
  input: Record<string, unknown>,
  questionIds?: string[],
  attemptId?: string,
) {
  const ids = questionIds ? new Set(questionIds) : undefined;
  const refs = collectAssetReferences(input);
  if (attemptId) {
    const attempt = store.get<StoredAttempt>('attempts', attemptId);
    for (const question of attempt?.questions || [])
      if (ids ? ids.has(question.id) : isSubjectiveType(question.type))
        collectAssetReferences(question, refs);
    for (const [id, answer] of Object.entries(attempt?.answers || {}))
      if (!ids || ids.has(id)) collectAssetReferences(answer, refs);
  } else if (typeof input.paperId === 'string') {
    const paper = store.get<StoredPaper>('papers', input.paperId);
    for (const question of paper?.snapshot || [])
      if (ids?.has(question.id)) collectAssetReferences(question, refs);
  } else {
    for (const id of ids || []) collectAssetReferences(store.get('questions', id), refs);
  }
  return [...refs];
}
export function taskSnapshot(store: Store, operation: string, body?: unknown) {
  operation = operation.split('?')[0]!;
  if (
    [
      '/api/packages/preview',
      '/api/packages/export',
      '/api/content-exports',
      '/api/migrations/preview',
      '/api/migrations/database',
      '/api/backup.sqlite',
      '/api/maintenance/health',
    ].includes(operation) ||
    operation.endsWith('/import-preview')
  ) {
    return { guards: [], finish: (): TaskChangeSet => ({ guards: [], patches: [] }) };
  }
  const ai = operation.includes('/ai/') || operation.endsWith('/ai-review');
  const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const jobId = operation.match(/^\/api\/ai\/document-jobs\/([^/]+)\//)?.[1];
  const selectedIds =
    typeof input.questionId === 'string'
      ? [input.questionId]
      : Array.isArray(input.questionIds) && input.questionIds.every((id) => typeof id === 'string')
        ? (input.questionIds as string[])
        : undefined;
  const runId = operation.match(/^\/api\/ai\/runs\/([^/]+)\/import$/)?.[1];
  const writable: Array<{ table: RecordTable; ids?: string[] }> = ai
    ? runId
      ? [{ table: 'ai_runs', ids: [runId] }]
      : []
    : recordTables.map((table) => ({ table }));
  const db = store.database;
  // Model endpoints append audit and completed runs. Only confirmed AI
  // imports update an existing run, whose ID is known before execution.
  const existingRunIds = ai
    ? db.all(db.query.selectFrom('ai_runs').select('id')).map((row) => row.id)
    : undefined;
  if (ai && jobId) writable.push({ table: 'ai_import_jobs', ids: [jobId] });
  if (ai && operation.endsWith('/import') && operation !== '/api/ai/import')
    writable.push({ table: 'questions' }, { table: 'question_revisions' });
  if (operation === '/api/ai/review') writable.push({ table: 'questions', ids: selectedIds });
  if (operation === '/api/question-feedback/ai-review')
    writable.push({ table: 'question_feedback' }, { table: 'quality_issues' });
  let dependencies: Array<{ table: RecordTable; ids?: string[] }> = contentTables.map((table) => ({
    table,
  }));
  if (ai) {
    const attemptId =
      operation.match(/^\/api\/attempts\/([^/]+)\/ai-review$/)?.[1] ||
      (typeof input.attemptId === 'string' ? input.attemptId : undefined);
    if (operation === '/api/question-feedback/ai-review') {
      dependencies = [{ table: 'questions' }, { table: 'categories' }, { table: 'domains' }];
      if (Array.isArray(input.ids) && input.ids.every((id) => typeof id === 'string'))
        dependencies.push({ table: 'question_feedback', ids: input.ids as string[] });
    } else if (operation === '/api/ai/similar-questions') {
      // Similarity retrieval reads candidates beyond the selected source.
      dependencies = ['questions', 'categories', 'domains', 'tags'].map((table) => ({
        table: table as RecordTable,
      }));
    } else if (
      operation.endsWith('/explain') ||
      operation.endsWith('/grade') ||
      operation.endsWith('/ai-review')
    ) {
      dependencies = [
        { table: 'assets', ids: relatedAiAssets(store, input, selectedIds, attemptId) },
      ];
      if (selectedIds && !attemptId) dependencies.push({ table: 'questions', ids: selectedIds });
      if (typeof input.paperId === 'string')
        dependencies.push({ table: 'papers', ids: [input.paperId] });
    } else if (operation === '/api/ai/review' || operation === '/api/ai/question-edit') {
      dependencies = [
        { table: 'questions', ids: selectedIds },
        { table: 'assets', ids: relatedAiAssets(store, input, selectedIds) },
        { table: 'domains' },
        { table: 'categories' },
        { table: 'tags' },
      ];
      if (operation === '/api/ai/question-edit' && selectedIds?.length) {
        const db = store.database;
        const issues = db.all(
          db.query
            .selectFrom('quality_issues')
            .select('id')
            .where(
              db.expressions.idInJson(
                db.expressions.field<string>('data', 'questionId'),
                selectedIds,
              ),
            ),
        );
        dependencies.push({ table: 'quality_issues', ids: issues.map((issue) => issue.id) });
      }
    } else if (operation.endsWith('/paper-plan')) {
      dependencies = ['domains', 'categories', 'tags', 'questions'].map((table) => ({
        table: table as RecordTable,
      }));
    } else if (operation === '/api/ai/import') {
      dependencies = [{ table: 'domains' }, { table: 'categories' }, { table: 'tags' }];
    } else if (jobId && /\/plan$/.test(operation)) {
      dependencies = [];
    } else if (jobId && /\/generate$/.test(operation)) {
      dependencies = ['domains', 'categories', 'tags', 'settings'].map((table) => ({
        table: table as RecordTable,
      }));
    } else if (selectedIds) {
      const questions = dependencies.find((item) => item.table === 'questions')!;
      questions.ids = selectedIds;
    }
    if (attemptId) dependencies.push({ table: 'attempts', ids: [attemptId] });
    if (jobId) dependencies.push({ table: 'ai_import_jobs', ids: [jobId] });
    // Configuration changes and unrelated attempts/jobs must not invalidate a
    // model response. Their own writes are still protected by row versions.
  } else dependencies.push({ table: 'settings' });
  const guards = dependencies.map((item) => ({
    ...item,
    fingerprint: fingerprint(store, item.table, item.ids),
  }));
  const baseline = new Map<RecordTable, Map<string, string>>();
  function rows(table: RecordTable, ids?: string[]) {
    if (ids?.length === 0) return [];
    const query = db.query.selectFrom(table).select(['id', 'data']);
    return db.all(ids ? query.where(db.expressions.idInJson('id', ids)) : query);
  }
  for (const { table, ids } of writable)
    baseline.set(
      table,
      new Map(rowFingerprints(store, table, ids).map((row) => [row.id, row.hash])),
    );
  return {
    guards,
    finish(): TaskChangeSet {
      const patches: TaskPatch[] = [];
      for (const { table, ids } of writable) {
        const original = baseline.get(table)!;
        const seen = new Set<string>();
        const changed: string[] = [];
        for (const row of rowFingerprints(store, table, ids)) {
          seen.add(row.id);
          if (original.get(row.id) !== row.hash) changed.push(row.id);
        }
        for (const row of rows(table, changed))
          patches.push({
            table,
            id: row.id,
            before: original.get(row.id) || null,
            data: JSON.parse(row.data),
          });
        for (const [id, before] of original) if (!seen.has(id)) patches.push({ table, id, before });
      }
      if (existingRunIds) {
        const added = db.all(
          db.query
            .selectFrom('ai_runs')
            .select(['id', 'data'])
            .where((eb) => eb.not(db.expressions.idInJson('id', existingRunIds))),
        );
        for (const row of added)
          patches.push({ table: 'ai_runs', id: row.id, before: null, data: JSON.parse(row.data) });
      }
      if ((jobId && /\/generate$/.test(operation)) || operation === '/api/ai/question-edit') {
        // Only model output reveals these references. These operations do not
        // mutate assets, so the hashes still describe the original copy.
        const ids = [
          ...collectAssetReferences(
            patches.filter((patch) => patch.table === 'ai_runs').map((patch) => patch.data),
          ),
        ];
        if (ids.length)
          guards.push({ table: 'assets', ids, fingerprint: fingerprint(store, 'assets', ids) });
      }
      return { guards, patches };
    },
  };
}
export function taskWasCommitted(store: Store, id: string): boolean {
  return !!store.database.one(
    store.database.query.selectFrom('metadata').select('key').where('key', '=', taskCommitKey(id)),
  );
}
/** Only trusted worker results reach this function. All read dependencies are
 * checked before any write; unrelated learning writes are retained. */
export function commitTaskChanges(store: Store, id: string, changes?: TaskChangeSet) {
  const db = store.database;
  db.transaction(() => {
    if (taskWasCommitted(store, id)) return;
    if (changes?.patches.length) {
      // Failed provider audits contain diagnostics only, not a content result.
      // Keep them even if the user edited the source while the call failed.
      const auditOnly = changes.patches.every(
        (patch) =>
          patch.table === 'ai_runs' &&
          patch.before === null &&
          patch.data &&
          ['failed', 'cancelled'].includes((patch.data as { status?: string }).status || ''),
      );
      const validated = new Map<RecordTable, Set<string> | null>();
      for (const guard of auditOnly ? [] : changes.guards) {
        if (fingerprint(store, guard.table, guard.ids) !== guard.fingerprint)
          fail(
            409,
            'TASK_SOURCE_CHANGED',
            '处理期间相关题目、题集或导入范围发生变化，结果未覆盖本机数据；请重新预览或重试。',
          );
        validated.set(guard.table, guard.ids ? new Set(guard.ids) : null);
      }
      const byTable = new Map<RecordTable, TaskPatch[]>();
      for (const patch of changes.patches) {
        if (!recordTables.includes(patch.table))
          fail(400, 'TASK_PATCH_INVALID', '后台任务变更无效');
        const list = byTable.get(patch.table);
        if (list) list.push(patch);
        else byTable.set(patch.table, [patch]);
      }
      // A validated table fingerprint already covers every row in that scope.
      // Check the remaining rows in batches before applying any write.
      for (const [table, patches] of byTable) {
        const covered = validated.get(table);
        if (covered === null) continue;
        const unchecked = covered ? patches.filter((patch) => !covered.has(patch.id)) : patches;
        if (!unchecked.length) continue;
        const rows = db.all(
          db.query
            .selectFrom(table)
            .select('id')
            .select(db.recordFingerprint('data').as('hash'))
            .where(
              db.expressions.idInJson(
                'id',
                unchecked.map((patch) => patch.id),
              ),
            ),
        );
        const live = new Map(rows.map((row) => [row.id, row.hash]));
        if (unchecked.some((patch) => (live.get(patch.id) ?? null) !== patch.before))
          fail(409, 'TASK_SOURCE_CHANGED', '处理期间本机记录已修改，请重试。');
      }
      for (const [table, patches] of byTable) {
        const removed: string[] = [],
          rows: Array<{ id: string; data: string }> = [];
        for (const patch of patches) {
          if (patch.data === undefined) removed.push(patch.id);
          else rows.push({ id: patch.id, data: JSON.stringify(patch.data) });
        }
        // Two bound parameters per row. Keep SQLite's triggers and stay well
        // below the minimum variable limit on every supported platform.
        for (let offset = 0; offset < rows.length; offset += 100)
          db.run(
            db.query
              .insertInto(table)
              .values(rows.slice(offset, offset + 100))
              .onConflict((conflict) =>
                conflict.column('id').doUpdateSet((eb) => ({ data: eb.ref('excluded.data') })),
              ),
          );
        if (removed.length)
          db.run(db.query.deleteFrom(table).where(db.expressions.idInJson('id', removed)));
      }
    }
    db.run(
      db.query
        .insertInto('metadata')
        .values({ key: taskCommitKey(id), value: new Date().toISOString() })
        .onConflict((c) => c.column('key').doNothing()),
    );
  });
}
