/** Remove retired product-specific metadata only at its known structured paths.
 * Text, arbitrary user objects, personal collections and learning history remain intact.
 */
type ObjectRecord = Record<string, unknown>;
const object = (value: unknown): value is ObjectRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
function without(value: unknown, key: string): unknown {
  if (!object(value) || !Object.hasOwn(value, key)) return value;
  const copy = { ...value }; delete copy[key]; return copy;
}
function field(value: unknown, key: string, transform: (input: unknown) => unknown): unknown {
  if (!object(value) || !Object.hasOwn(value, key)) return value;
  const next = transform(value[key]);
  return next === value[key] ? value : { ...value, [key]: next };
}
function array(value: unknown, transform: (input: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;
  const next = value.map(transform);
  return next.some((item, index) => item !== value[index]) ? next : value;
}
const question = (value: unknown) => without(value, 'resumePriority');
const filters = (value: unknown) => without(value, 'priority');
export const learningMetadataTables = ['questions', 'papers', 'attempts', 'paper_drafts'] as const;

export function cleanLearningRecord<T>(table: string, value: T): T {
  let next: unknown = value;
  if (table === 'questions') next = question(next);
  if (table === 'papers') {
    next = field(next, 'filters', filters);
    next = field(next, 'snapshot', items => array(items, question));
  }
  if (table === 'attempts') next = field(next, 'questions', items => array(items, question));
  if (table === 'paper_drafts') next = field(next, 'state', state => field(field(state, 'filters', filters), 'random', filters));
  return next as T;
}

/** Normalize an imported full backup without interpreting notes or arbitrary fields. */
export function cleanLearningEnvelope<T>(value: T): T {
  let next: unknown = value;
  for (const table of learningMetadataTables) {
    const key = table === 'paper_drafts' ? 'paperDrafts' : table;
    next = field(next, key, items => array(items, item => cleanLearningRecord(table, item)));
  }
  return next as T;
}
