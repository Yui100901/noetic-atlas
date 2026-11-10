import { useEffect, useRef, useState } from 'react';
/** Only an accepted persistent task permits closing its busy dialog. Local
 * file parsing/rendering and the initial request remain protected. */
export function useTaskDetachable(
  operation: string | ((operation: string) => boolean),
  busy: boolean,
) {
  const [accepted, setAccepted] = useState(false);
  const latest = useRef({ operation, busy });
  latest.current = { operation, busy };
  useEffect(() => {
    if (!busy) setAccepted(false);
  }, [busy]);
  useEffect(() => {
    const listener = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail?.operation,
        scope = latest.current;
      if (
        scope.busy &&
        typeof value === 'string' &&
        (typeof scope.operation === 'string' ? scope.operation === value : scope.operation(value))
      )
        setAccepted(true);
    };
    window.addEventListener('atlas-task-started', listener);
    return () => window.removeEventListener('atlas-task-started', listener);
  }, []);
  return busy && accepted;
}
