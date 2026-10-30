import { containsAiMath } from '../../../shared/ai/math.js';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { storedCompletedAiRunSchema } from './run-schema.js';

/** Validate before the authoritative write. Callers applying a result use their
 * existing transaction to keep question/attempt changes and AI metadata atomic. */
export function putCompletedAiRun(store: Store, value: unknown) {
  if (
    value &&
    typeof value === 'object' &&
    'result' in value &&
    'id' in value &&
    !store.database.getRecord('ai_runs', String(value.id)) &&
    containsAiMath(value.result)
  )
    Object.assign(value, { mathEnabled: true });
  const run = parse(storedCompletedAiRunSchema, value);
  store.database.putRecord('ai_runs', run.id, run);
  return run;
}
