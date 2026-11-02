import type { Store } from '../../core/store.js';
import type { MaintenanceOperation } from '../../../shared/models/maintenance.js';
const key = 'maintenance_journal_v1';
export function maintenanceJournal(store: Store): MaintenanceOperation[] {
  const row = store.database.one(
    store.database.query.selectFrom('metadata').select('value').where('key', '=', key),
  );
  if (!row) return [];
  try {
    const value: unknown = JSON.parse(row.value);
    return Array.isArray(value)
      ? value
          .filter(
            (entry): entry is MaintenanceOperation =>
              !!entry &&
              typeof entry === 'object' &&
              typeof entry.at === 'string' &&
              Number.isFinite(Date.parse(entry.at)) &&
              ['cleanup', 'reset', 'compact', 'reindex'].includes(entry.kind) &&
              typeof entry.summary === 'string' &&
              Number.isSafeInteger(entry.count) &&
              entry.count >= 0,
          )
          .slice(0, 20)
      : [];
  } catch {
    return [];
  }
}
/** A bounded local diagnostic trail, never question bodies, notes or API keys. */
export function recordMaintenance(store: Store, operation: Omit<MaintenanceOperation, 'at'>) {
  const value = JSON.stringify(
    [{ ...operation, at: new Date().toISOString() }, ...maintenanceJournal(store)].slice(0, 20),
  );
  store.database.run(
    store.database.query
      .insertInto('metadata')
      .values({ key, value })
      .onConflict((c) => c.column('key').doUpdateSet({ value })),
  );
}
