import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { storedCompletedAiRunSchema } from './run-schema.js';

/** Validate before the authoritative write. Callers applying a result use their
 * existing transaction to keep question/attempt changes and AI metadata atomic. */
export function putCompletedAiRun(store: Store, value: unknown) {
  const run = parse(storedCompletedAiRunSchema, value);
  store.database.putRecord('ai_runs', run.id, run);
  return run;
}
