import { z } from 'zod';
import type { DataPackageKind } from '../../../shared/models/data-packages.js';
import { tables, type Table } from '../../core/store.js';
import {
  fail,
  parse,
  newQuestionEnvelopeSchema,
  pendingEnvelopeSchema,
} from '../../core/validation.js';
import { configurationSchema } from '../settings/configuration.js';
import { sharePackageSchema } from '../sharing/schema.js';
import { migrationDataKey as migrationKey, migrationEnvelopeSchema } from './migration.js';

export function canonicalPackageValue(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalPackageValue).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalPackageValue(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function packageRecordId(table: Table, value: Record<string, unknown>): string | undefined {
  if (table === 'study') return value.questionId as string;
  if (table === 'study_parts') return JSON.stringify([value.questionId, value.partId]);
  return value.id as string | undefined;
}

/** Repeated cross-domain records must be byte-equivalent in meaning, never last-write-wins. */
function mergeRecords(groups: unknown[][], table: Table): unknown[] {
  const seen = new Map<string, unknown>(),
    values: unknown[] = [];
  for (const group of groups)
    for (const value of group) {
      const key = packageRecordId(table, value as Record<string, unknown>);
      if (!key) {
        values.push(value);
        continue;
      }
      const previous = seen.get(key);
      if (previous !== undefined) {
        if (canonicalPackageValue(previous) !== canonicalPackageValue(value))
          fail(400, 'PACKAGE_RECORD_CONFLICT', `数据包分片包含内容不同的相同ID：${table}/${key}`);
        continue;
      }
      seen.set(key, value);
      values.push(value);
    }
  return values;
}

export function combinePackagePayloads(
  kind: DataPackageKind,
  payloads: Array<{ data: unknown }>,
  title: string,
): any {
  if (kind === 'sqlite-backup')
    fail(
      422,
      'SQLITE_PACKAGE_RESTORE_REQUIRED',
      '这是完整数据库恢复包，请在完整备份与恢复中选择恢复，替换前会校验并备份本机数据',
    );
  if (!payloads.length) fail(400, 'PACKAGE_DATA_REQUIRED', '数据包没有可导入的数据分片');
  if (kind === 'configuration') {
    if (payloads.length !== 1)
      fail(400, 'PACKAGE_CONFIGURATION_AMBIGUOUS', '配置包只能包含一份配置');
    return parse(configurationSchema, payloads[0]!.data);
  }
  if (kind === 'question-template' || kind === 'question-update') {
    const schema: z.ZodType<any> =
      kind === 'question-template' ? newQuestionEnvelopeSchema : pendingEnvelopeSchema;
    const parts = payloads.map((x) => parse(schema, x.data));
    return parse(schema, { ...parts[0], questions: parts.flatMap((x) => x.questions) });
  }
  if (kind === 'share') {
    const parts = payloads.map((x) => parse(sharePackageSchema, x.data));
    const combined: Record<string, unknown> = { ...parts[0], title };
    for (const [field, table] of [
      ['domains', 'domains'],
      ['categories', 'categories'],
      ['tags', 'tags'],
      ['assets', 'assets'],
      ['questions', 'questions'],
      ['papers', 'papers'],
      ['questionBanks', 'question_banks'],
    ] as const)
      combined[field] = mergeRecords(
        parts.map((x) => x[field]),
        table,
      );
    return parse(sharePackageSchema, combined);
  }
  const parts = payloads.map((x) => parse(migrationEnvelopeSchema, x.data));
  const combined: Record<string, unknown> = { ...parts[0] };
  for (const table of tables) {
    const key = migrationKey(table);
    combined[key] = mergeRecords(
      parts.map((x) => (x as Record<string, any>)[key] || []),
      table,
    );
  }
  const result = parse(migrationEnvelopeSchema, combined);
  // Absence identifies old backups whose retained attempts still need their
  // question history backfilled. An explicit empty index must stay empty.
  if (!payloads.some(({ data }) => Object.hasOwn(data as object, 'questionHistory')))
    delete (result as Partial<typeof result>).questionHistory;
  return result;
}
