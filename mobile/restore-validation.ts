import type { SqlJsStatic } from 'sql.js';
import { z } from 'zod';
import { buildApp } from '../server/index';
import { Store } from '../server/core/store';
import { exportData, importData } from '../server/modules/transfer/migration';
import { id, leafId, parse, types } from '../server/core/validation';
import { aiSettingsSchema, explanationSchema, gradeResultSchema, importResultSchema, reviewResultSchema, aiPaperPlanOutputSchema } from '../server/modules/ai/schema';
import { completionEndpoint } from '../server/modules/ai/provider';
import { validateAssetReferences } from '../server/modules/assets/routes';
import { databaseForPath } from './shims/sqlite';
import { setVirtualFile, rmSync } from './shims/fs';
import { inspectSQLite, databaseCounts, activeExamCount, redactRestoreAiSettings } from './database/restore-database';

const stamp = z.string().datetime({ offset: true });
const ids = z.array(id).refine(values => new Set(values).size === values.length, '题号不能重复');
const leafIds = z.array(leafId).refine(values => new Set(values).size === values.length, '小题号不能重复');
const contextSchema = z.object({
  questionVersions: z.record(id, z.string()), sourceByItem: z.record(leafId, id), attemptVersion: z.string().optional(), candidateVersions: z.record(id, z.string()).optional(),
  partByItem: z.record(leafId, z.object({ partId: id, type: types.exclude(['group']) }).strict()).optional(),
}).strict().superRefine((value, context) => { for (const item of Object.keys(value.partByItem || {})) if (!value.sourceByItem[item]) context.addIssue({ code: 'custom', message: '小题 AI 上下文缺少原题引用' }); });
const runSchema = z.object({
  id, kind: z.enum(['explain', 'grade', 'import', 'review', 'paper_plan']), status: z.literal('completed'),
  createdAt: stamp, model: z.string().max(200), warnings: z.array(z.string()), questionIds: leafIds, attemptId: id.optional(),
  result: z.unknown(), _context: contextSchema, appliedAt: stamp.optional(), appliedScores: leafIds.optional(), appendedNotes: leafIds.optional(),
  importedQuestionIds: ids.optional(), correctedQuestionIds: ids.optional(), createdPaperId: id.optional(),
}).strict();
const planSchema = aiPaperPlanOutputSchema.extend({
  requestedCount: z.number().int().positive(), candidateCount: z.number().int().nonnegative(),
  candidates: z.array(z.object({ id, title: z.string(), type: types }).strict()),
  retrieval: z.object({ availableCount: z.number().int().nonnegative(), matchedCount: z.number().int().nonnegative(), reviewedCount: z.number().int().nonnegative(), batches: z.number().int().nonnegative(), interpreted: z.boolean(), summary: z.string() }).strict().optional(),
});
const invalid = (message: string): never => { throw new Error(`SQLite 备份校验失败：${message}`); };
function validatePrivateRecords(store: Store) {
  const settings = store.database.records<any>('ai_settings');
  if (settings.length > 1) invalid('AI 配置数量无效');
  for (const value of settings) { const config = parse(aiSettingsSchema, value); if (config.baseUrl) completionEndpoint(config.baseUrl); if (config.enabled && (!config.baseUrl || !config.model)) invalid('AI 配置缺少地址或模型'); }
  for (const value of store.database.records('ai_runs')) {
    const run = parse(runSchema, value);
    if (run.kind === 'explain') parse(explanationSchema, run.result);
    else if (run.kind === 'grade') {
      const result = parse(gradeResultSchema, run.result);
      if (result.items.some(item => item.score != null && item.maxPoints != null && item.score > item.maxPoints)) invalid('AI 评分超过满分');
      if (result.items.some(item => !run.questionIds.includes(item.questionId)) || new Set(result.items.map(item => item.questionId)).size !== result.items.length) invalid('AI 评分的题目引用无效');
    } else if (run.kind === 'import') parse(importResultSchema, run.result);
    else if (run.kind === 'review') { const result = parse(reviewResultSchema.extend({ approvedIds: ids }), run.result); if (result.items.some(item => !run.questionIds.includes(item.questionId)) || result.approvedIds.some(qid => !run.questionIds.includes(qid))) invalid('AI 审核的题目引用无效'); }
    else { const result = parse(planSchema, run.result); const candidates = new Set(result.candidates.map(item => item.id)); if (result.items.some(item => !candidates.has(item.questionId)) || new Set(result.items.map(item => item.questionId)).size !== result.items.length) invalid('AI 推荐的题目引用无效'); }
    // Analysis history can outlive retained attempts and deleted source questions.
    // Its structural IDs/context and managed asset references still must be valid.
    validateAssetReferences(store, run);
  }
}

/** All validation and upgrades happen on virtual independent copies. No JSON
 * transport/body limit applies, and neither invalid files nor empty SQLite files
 * can be mistaken for a new installation. The returned bytes own no credentials.
 */
export async function prepareSQLiteRestore(sql: SqlJsStatic, input: Uint8Array) {
  const path = `/native/restore-${crypto.randomUUID()}.sqlite`, checkPath = `${path}.check`;
  let source: Store | undefined, checker: Store | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    setVirtualFile(path, inspectSQLite(sql, input));
    source = new Store(path);
    const empty = new sql.Database();
    try { setVirtualFile(checkPath, empty.export()); } finally { empty.close(); }
    checker = new Store(checkPath);
    // Import into a genuinely empty Store: no same-ID skipping can mask invalid
    // questions, snapshots, scoring, configuration, learning data or references.
    importData(checker, exportData(source));
    validatePrivateRecords(source);
    const sourceHadAiKey = source.database.records<any>('ai_settings').some(value => Boolean(value.key));
    setVirtualFile(path, databaseForPath(path).export());
    source.db.close(); source = undefined;
    checker.db.close(); checker = undefined;
    app = await buildApp({ databasePath: path, staticRoot: '/not-a-web-server', native: true });
    const database = databaseForPath(path);
    redactRestoreAiSettings(database);
    return { bytes: database.export(), counts: databaseCounts(database), sourceHadAiKey, activeExamCount: activeExamCount(database) };
  } finally {
    source?.db.close(); checker?.db.close(); if (app) await app.close();
    rmSync(path); rmSync(checkPath);
  }
}

/** Recovery copies stay private with local credentials. Sharing one deliberately
 * uses the same validated, credential-free form as a normal SQLite export. */
export async function shareableRecoveryBytes(sql: SqlJsStatic, bytes: Uint8Array) { return (await prepareSQLiteRestore(sql, bytes)).bytes; }
