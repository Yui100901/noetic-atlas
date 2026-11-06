import { createHash } from 'node:crypto';
import type { ImportDedupOptions } from '../../../shared/models/import-dedup.js';
import type { ImportTaxonomyMapping } from '../../../shared/models/import-taxonomy.js';
import {
  reusePackageQuestionHash,
  type PackageQuestionHashSource,
} from '../../../shared/packages/question-hashes.js';
import type {
  DataPackageCount,
  DataPackageKind,
  DataPackagePreview,
} from '../../../shared/models/data-packages.js';
import { tables, type Store, type Table } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { collectAssetReferences, validateAssetReferences } from '../assets/service.js';
import { assertNewQuestionId } from '../questions/import-export.js';
import { previewConfiguration } from '../settings/configuration.js';
import { planShareImport } from '../sharing/service.js';
import { migrationDataKey as migrationKey } from './migration.js';
import { canonicalPackageValue, packageRecordId } from './package-payload.js';
import { previewQuestionImport } from '../question-imports/service.js';
import { normalizeQuestionBlankStems } from '../../../shared/questions/blank-markers.js';

const zero = (): DataPackageCount => ({ added: 0, reused: 0, remapped: 0, skipped: 0 });
function relevantIds(kind: DataPackageKind, data: any): Map<Table, Set<string>> {
  const result = new Map<Table, Set<string>>();
  const add = (table: Table, values: unknown[]) => {
    const ids = result.get(table) || new Set<string>();
    for (const id of values) if (typeof id === 'string') ids.add(id);
    result.set(table, ids);
  };
  if (kind === 'migration')
    for (const table of tables)
      add(
        table,
        (data[migrationKey(table)] || []).map((x: any) => packageRecordId(table, x)),
      );
  else if (kind === 'question-template' || kind === 'question-update')
    add(
      'questions',
      data.questions.map((x: any) => x.id),
    );
  const relations: Record<string, Table> = {
    questionId: 'questions',
    sourceQuestionId: 'questions',
    paperId: 'papers',
    documentId: 'documents',
    versionId: 'document_versions',
    assetId: 'assets',
    categoryIds: 'categories',
    tagIds: 'tags',
    domainIds: 'domains',
    questionIds: 'questions',
  };
  const stack: unknown[] = [data];
  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(relations, key))
        add(relations[key]!, Array.isArray(child) ? child : [child]);
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  add('assets', [...collectAssetReferences(data)]);
  add('settings', ['system']);
  return result;
}

/** Compact source projections only: no exported full-bank clone for a preview. */
function stateFingerprint(store: Store, kind: DataPackageKind, data: unknown): string {
  const digest = createHash('sha256'),
    db = store.database;
  const scope = relevantIds(kind, data);
  for (const table of ['domains', 'categories', 'tags'] as const) {
    digest.update(table);
    digest.update(
      canonicalPackageValue(
        db.all(
          db.query
            .selectFrom(table)
            .select('id')
            .select(db.recordFingerprint('data').as('fingerprint'))
            .orderBy('id'),
        ),
      ),
    );
    scope.delete(table);
  }
  for (const [table, ids] of [...scope].sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(table);
    const selected = [...ids].sort();
    for (let offset = 0; offset < selected.length; offset += 400) {
      const part = selected.slice(offset, offset + 400);
      digest.update(canonicalPackageValue(part));
      digest.update(
        canonicalPackageValue(
          db.all(
            db.query
              .selectFrom(table)
              .select('id')
              .select(db.recordFingerprint('data').as('fingerprint'))
              .where('id', 'in', part)
              .orderBy('id'),
          ),
        ),
      );
    }
  }
  return digest.digest('hex');
}

function countsForMigration(store: Store, data: any): Record<string, DataPackageCount> {
  const counts: Record<string, DataPackageCount> = {},
    db = store.database;
  for (const table of tables) {
    const key = migrationKey(table),
      rows = (data[key] || []) as Record<string, unknown>[];
    const count = (counts[key] = zero());
    const ids = rows.map((x) => packageRecordId(table, x)).filter((x): x is string => !!x);
    let existing = 0;
    for (let offset = 0; offset < ids.length; offset += 400)
      existing += db.all(
        db.query
          .selectFrom(table)
          .select('id')
          .where('id', 'in', ids.slice(offset, offset + 400)),
      ).length;
    count.added = rows.length - existing;
    count.skipped = existing;
  }
  return counts;
}

export function inspectDataPackage(
  store: Store,
  kind: DataPackageKind,
  title: string,
  data: any,
  packageHash: string,
  options: {
    dedup?: ImportDedupOptions;
    taxonomyMapping?: ImportTaxonomyMapping;
    hashSources?: ReadonlyArray<PackageQuestionHashSource>;
  } = {},
): DataPackagePreview {
  let localFingerprint: string;
  const preview: DataPackagePreview = { kind, title, fingerprint: '', counts: {}, warnings: [] };
  if (
    kind !== 'share' &&
    options.taxonomyMapping &&
    Object.values(options.taxonomyMapping).some((values) => values?.length)
  )
    fail(
      400,
      'IMPORT_TAXONOMY_MAPPING_UNSUPPORTED',
      '此包保留原迁移身份或使用本地模板归类，不能执行来源归类映射；请使用分享包调整归属。',
    );
  if (kind === 'share') {
    const sharePlan = planShareImport(store, data, options.dedup, true, options),
      planned = sharePlan.preview;
    preview.dedup = sharePlan.dedup;
    preview.taxonomy = sharePlan.preview.taxonomy;
    for (const [key, value] of Object.entries(planned.counts))
      preview.counts[key] = { ...zero(), ...value };
    preview.questions = planned.questions;
    preview.warnings = planned.warnings;
    localFingerprint = planned.fingerprint;
  } else if (kind === 'configuration') {
    preview.details = previewConfiguration(store, data);
    preview.warnings = preview.details.warnings;
    localFingerprint = preview.details.fingerprint;
  } else {
    localFingerprint = stateFingerprint(store, kind, data);
    if (kind === 'migration') {
      preview.counts = countsForMigration(store, data);
      preview.warnings = [
        '这是可信迁移包，将保留来源审核状态。只导入自己或可信来源的备份。',
        '已完成整包格式、摘要和重复ID检查；所有关联依赖将在确认导入的单一事务中再次验证，任一问题都会整包回滚。',
        '同ID已有内容按迁移规则保留；本机仍为初始默认配置时可恢复备份配置。',
      ];
    } else {
      const entries = data.questions as Array<{ id?: string; title: string; updatedAt?: string }>;
      for (const q of entries) {
        if (kind === 'question-template') {
          assertNewQuestionId(q.id);
        } else {
          const local = store.require<any>('questions', q.id!);
          if (local.status !== 'pending')
            fail(409, 'QUESTION_NOT_PENDING', `只能更新现有待审核题目：${q.id}`);
          if (local.updatedAt !== q.updatedAt)
            fail(409, 'QUESTION_VERSION_CONFLICT', `题目已被修改，请重新导出：${q.id}`);
        }
        store.validateRefs(q as any);
        validateAssetReferences(store, q);
      }
      preview.counts.questions = {
        ...zero(),
        added: kind === 'question-template' ? entries.length : 0,
        reused: kind === 'question-update' ? entries.length : 0,
      };
      preview.warnings = [
        kind === 'question-template'
          ? '新增题目全部进入待审核；包内原审核状态不会作为通过审核的依据。'
          : '只更新相同版本的待审核题目，保持待审核并保留修订记录。',
      ];
      preview.questions = entries.map((x, i) => ({
        id: x.id || `new-${i + 1}`,
        title: x.title,
        status: 'pending',
      }));
      if (kind === 'question-template') {
        preview.dedup = previewQuestionImport(
          store,
          data.questions.map(normalizeQuestionBlankStems),
          undefined,
          options.dedup,
          data.questions.map((question: any, index: number) => {
            const source = options.hashSources?.[index];
            return source?.hint
              ? reusePackageQuestionHash(
                  source.question,
                  normalizeQuestionBlankStems(question),
                  source.hint,
                  source.assetKey,
                  store.database.imports.assetResolver(),
                )
              : undefined;
          }),
        );
        preview.counts.questions.added = preview.dedup.counts.new + preview.dedup.counts.similar;
        preview.counts.questions.reused = preview.dedup.counts.exact;
        localFingerprint = createHash('sha256')
          .update(localFingerprint + preview.dedup.fingerprint)
          .digest('hex');
      }
    }
  }
  preview.fingerprint = createHash('sha256')
    .update(
      canonicalPackageValue({
        packageHash,
        localFingerprint,
        dedupEnabled: options.dedup?.enabled !== false,
        taxonomyMapping: options.taxonomyMapping || {},
      }),
    )
    .digest('hex');
  return preview;
}
