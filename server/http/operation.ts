/** POST queries declare their persistence effect next to their handler. This
 * affects native durable commits only, never authorization or the exam guard.
 * Derived read caches may refresh; authoritative data and audit records may not
 * change. Undeclared non-GET operations remain writes by default. */
export const readOnlyOperation = { config: { storageEffect: 'read' } } as const;
export type StorageEffect = 'read' | 'write';
