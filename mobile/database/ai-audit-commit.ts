import type { SqlValue } from 'sql.js';
import { createQueryBuilder } from '../../server/database/query-builder';
import { aiFailedRunSchema } from '../../server/modules/ai/audit-schema';
import { AI_AUDIT_HEADER } from '../../server/modules/ai/audit-errors';
import type { DatabaseSync } from '../shims/sqlite';

const query = createQueryBuilder();
type FailedAudit = ReturnType<typeof aiFailedRunSchema.parse>;

/** Only an internal response marker can retain a newly written failure record.
 * The failed request's other changes are rolled back before this row is replayed.
 * Never copy provider text, successful results, or arbitrary table changes. */
export function pendingFailureAudit(database: DatabaseSync, response: Response, pathname: string, startedAt: number): FailedAudit | undefined {
  if (response.ok || !(/^\/api\/ai\//.test(pathname) || /^\/api\/attempts\/[^/]+\/ai-review$/.test(pathname))) return;
  const id = response.headers.get(AI_AUDIT_HEADER);
  if (!id || !/^[\p{L}\p{N}_.:-]{1,160}$/u.test(id)) return;
  const compiled = query.selectFrom('ai_runs').select('data').where('id', '=', id).compile();
  const row = database.prepare(compiled.sql).get(...compiled.parameters as SqlValue[]);
  if (!row || typeof row.data !== 'string') return;
  let value: unknown; try { value = JSON.parse(row.data); } catch { return; }
  const parsed = aiFailedRunSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id || Date.parse(parsed.data.createdAt) < startedAt) return;
  return parsed.data;
}

export function replayFailureAudit(database: DatabaseSync, audit: FailedAudit) {
  const compiled = query.insertInto('ai_runs').values({ id: audit.id, data: JSON.stringify(audit) }).onConflict(conflict => conflict.column('id').doNothing()).compile();
  database.prepare(compiled.sql).run(...compiled.parameters as SqlValue[]);
}
