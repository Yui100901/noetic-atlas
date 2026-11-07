/** Reproducible disk-backed transfer benchmark. Never opens operator data. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Store } from '../../server/core/store.js';
import { questionSchema, parse } from '../../server/core/validation.js';
import { fixtureQuestion } from '../../tests/fixtures/learning-seed.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import {
  previewContentExport,
  buildContentExport,
} from '../../server/modules/transfer/domain-exports.js';
import { previewDataPackage, importDataPackage } from '../../server/modules/transfer/packages.js';
import { previewQuestionImport } from '../../server/modules/question-imports/service.js';
import { readDataPackage } from '../../shared/packages/data-package.js';
import {
  sqliteMigrationPlan,
  exportSQLiteMigration,
} from '../../server/modules/transfer/sqlite-migration.js';
import { buildPaper, createAttempt, submitAttempt } from '../../server/modules/practice/service.js';

const count = Number(process.env.TRANSFER_SCALE_COUNT || 37400);
assert.ok(Number.isSafeInteger(count) && count >= 100 && count <= 50000);
const dir = await mkdtemp(join(tmpdir(), 'atlas-transfer-scale-'));
const folder = resolve('test-results/transfer-scale');
await mkdir(folder, { recursive: true });
const opened: Store[] = [],
  timings: Record<string, number> = {};
const open = (name: string) => {
  const value = new Store(join(dir, name));
  opened.push(value);
  return value;
};
async function measure<T>(name: string, action: () => T | Promise<T>): Promise<T> {
  const start = performance.now(),
    value = await action();
  timings[name] = Number(((timings[name] || 0) + performance.now() - start).toFixed(3));
  console.log(JSON.stringify({ stage: name, ms: timings[name] }));
  return value;
}
const rowCount = (
  store: Store,
  table: 'questions' | 'attempts' | 'question_history' | 'learning_results',
) =>
  Number(
    store.database.one(
      store.database.query.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')),
    )!.n,
  );
const source = open('source.sqlite'),
  receiver = open('receiver.sqlite');
try {
  const domains = Array.from({ length: 4 }, (_, i) => `scale-domain-${i}`);
  await measure('seedDiskDatabase', () =>
    source.transaction(() => {
      for (const [index, id] of domains.entries()) {
        source.put('domains', id, {
          id,
          name: `规模领域${index}`,
          description: '',
          sortOrder: index,
        });
        source.put('categories', `${id}-basic`, {
          id: `${id}-basic`,
          domainId: id,
          parentId: null,
          name: '基础知识',
          description: '',
          sortOrder: 0,
        });
      }
      source.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
      for (let i = 0; i < count; i++) {
        const token = (Math.imul(i + 1, 2654435761) >>> 0).toString(16),
          id = `SCALE-${String(i).padStart(6, '0')}`;
        const question = parse(
          questionSchema,
          fixtureQuestion(id, i % 3 ? 'true_false' : 'short_answer', {
            title: `概念 ${token}`,
            stemMarkdown: `合成测试${token}：解释边界与适用条件。`.repeat(12),
            answerMarkdown: `参考结论${token}；条件变化时应重新判断。`.repeat(10),
            explanationMarkdown: `解析${token}：区分充分条件与必要条件，并检查反例。`.repeat(8),
            gradingRequirements: i % 3 ? '' : `说明概念${token}的成立条件，并举出一个反例。`,
            categoryIds: [`${domains[i % domains.length]}-basic`],
            tagIds: [],
          }),
        );
        source.put('questions', id, question);
      }
      for (let i = 0; i < 20; i++) {
        const ids = Array.from(
          { length: 5 },
          (_, j) => `SCALE-${String((i * 5 + j) % count).padStart(6, '0')}`,
        );
        const paper = buildPaper(source, {
          title: `规模历史题集${i}`,
          description: '',
          mode: 'manual',
          questionIds: ids,
        });
        source.put('papers', paper.id, paper);
        submitAttempt(
          source,
          createAttempt(source, paper),
          Object.fromEntries(ids.map((id) => [id, { value: 'false' }])),
        );
      }
    }),
  );
  await measure('initialReadAndHashIndexes', () => {
    source.database.projections.rebuild();
    source.database.imports.ensure();
  });
  const selection = { domainIds: domains, purpose: 'share' as const, mode: 'per_domain' as const };
  const preview = await measure('exportPreflight', () => previewContentExport(source, selection));
  assert.equal(preview.questionCount, count);
  // Realistic 37k long questions exceed the conservative ZIP budget. Check
  // that refusal has actionable guidance, then exercise the recommended split.
  if (!preview.preflight.allowed) assert.ok(preview.preflight.recommendations.length);
  const batches = preview.preflight.allowed ? [domains] : domains.map((id) => [id]);
  const files = [];
  const firstCounts = { new: 0, exact: 0, similar: 0 };
  const repeatCounts = { new: 0, exact: 0, similar: 0 };
  const repeatHashMetrics = { hashesReused: 0, hashesComputed: 0, compared: 0 };
  for (const domainIds of batches) {
    const scope = { ...selection, domainIds };
    const batch = await measure('exportSplitPreflight', () => previewContentExport(source, scope));
    assert.equal(batch.preflight.allowed, true, JSON.stringify(batch.preflight));
    const file = await measure('exportZipAllDomains', () =>
      buildContentExport(source, { ...scope, expectedFingerprint: batch.fingerprint }),
    );
    files.push(file);
    const checked = await measure('verifyZipManifestAndHashes', () =>
      readDataPackage(Buffer.from(file.dataBase64, 'base64')),
    );
    assert.equal(
      checked.payloads.reduce(
        (n, payload) => n + ((payload.data as any).questions?.length || 0),
        0,
      ),
      batch.questionCount,
    );
    const first = await measure('firstImportPreviewDefaultDedup', () =>
      previewDataPackage(receiver, { dataBase64: file.dataBase64 }),
    );
    assert.equal(first.dedup?.total, batch.questionCount);
    for (const kind of ['new', 'exact', 'similar'] as const)
      firstCounts[kind] += first.dedup!.counts[kind];
    const decisions = first
      .dedup!.items.filter((item) => item.kind === 'similar')
      .map((item) => ({ key: item.key, action: 'both' as const }));
    await measure('firstImportCommit', () =>
      importDataPackage(receiver, {
        dataBase64: file.dataBase64,
        expectedFingerprint: first.fingerprint,
        confirmed: true,
        decisions,
      }),
    );
  }
  assert.equal(rowCount(receiver, 'questions'), count);
  for (const file of files) {
    const repeated = await measure('repeatImportPreviewDefaultDedup', () =>
      previewDataPackage(receiver, { dataBase64: file.dataBase64 }),
    );
    for (const kind of ['new', 'exact', 'similar'] as const)
      repeatCounts[kind] += repeated.dedup!.counts[kind];
    for (const kind of ['hashesReused', 'hashesComputed', 'compared'] as const)
      repeatHashMetrics[kind] += repeated.dedup!.metrics[kind] || 0;
    await measure('repeatImportCommitNoDuplicates', () =>
      importDataPackage(receiver, {
        dataBase64: file.dataBase64,
        expectedFingerprint: repeated.fingerprint,
        confirmed: true,
      }),
    );
    const disabled = await measure('importPreviewDedupDisabled', () =>
      previewDataPackage(receiver, { dataBase64: file.dataBase64, dedup: { enabled: false } }),
    );
    assert.equal(disabled.dedup!.enabled, false);
  }
  assert.equal(repeatCounts.exact, count);
  assert.equal(rowCount(receiver, 'questions'), count);
  const originals = receiver.database
    .all(receiver.database.query.selectFrom('questions').select('data').orderBy('id').limit(200))
    .map((row) => JSON.parse(row.data));
  const similar = await measure('similar200AgainstFullBank', () =>
    previewQuestionImport(
      receiver,
      originals.map((q) => ({ ...q, answerMarkdown: q.answerMarkdown + '修订参考结论' })),
    ),
  );
  assert.equal(similar.counts.similar, originals.length);
  assert.ok(similar.metrics.compared <= originals.length * similar.metrics.candidateLimit * 2);
  const migration = await measure(
    'fullMigrationPreview',
    () => sqliteMigrationPlan(source, { domainIds: [] }).preview,
  );
  const database = await measure('fullMigrationExportValidateCompact', () =>
    exportSQLiteMigration(source, { domainIds: [] }, migration.fingerprint),
  );
  const restorePath = join(dir, 'restored.sqlite');
  await writeFile(restorePath, database.bytes);
  const restored = await measure('fullMigrationOpenRestored', () => {
    const value = new Store(restorePath);
    opened.push(value);
    return value;
  });
  for (const table of ['questions', 'attempts', 'question_history', 'learning_results'] as const)
    assert.equal(rowCount(restored, table), rowCount(source, table));
  const scoped = await measure(
    'domainMigrationPreview',
    () => sqliteMigrationPlan(source, { domainIds: [domains[0]!] }).preview,
  );
  const scopedDatabase = await measure('domainMigrationExportValidateCompact', () =>
    exportSQLiteMigration(source, { domainIds: [domains[0]!] }, scoped.fingerprint),
  );
  const sourceBytes = (await stat(join(dir, 'source.sqlite'))).size;
  const report = {
    ok: true,
    isolated: true,
    diskBacked: true,
    platform: `${platform()}-${arch()}`,
    node: process.version,
    questions: count,
    domains: domains.length,
    sourceBytes,
    zipBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
    zipPackages: files.length,
    wholeZipPreflightAllowed: preview.preflight.allowed,
    fullMigrationBytes: database.bytes.length,
    domainMigrationBytes: scopedDatabase.bytes.length,
    domainSeedQuestions: scoped.seedQuestions,
    domainDependencyQuestions: scoped.dependencyQuestions,
    firstImportDedup: firstCounts,
    repeatImportDedup: repeatCounts,
    repeatHashMetrics,
    similarMetrics: similar.metrics,
    timingsMs: timings,
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    note: 'Synthetic local disk service timings; no network transfer or real operator data. Warm indexes measured separately. Default dedup stays enabled. No brittle wall-clock assertions.',
  };
  await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const store of opened.reverse()) store.database.close();
  const target = resolve(dir);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('atlas-transfer-scale-'));
  await rm(target, { recursive: true, force: true });
}
