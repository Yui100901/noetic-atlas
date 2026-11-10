/** Normalize a mounted page's query state without taking back a newer route.
 * Passive effects may run after an anchor has already changed the hash. Keep
 * redirects separate: normalization must stay on the exact same hash path. */
export function replaceCurrentHashLocation(targetHash: string): boolean {
  const currentHash = window.location.hash;
  if (currentHash === targetHash || currentHash.split('?')[0] !== targetHash.split('?')[0])
    return false;
  window.history.replaceState(window.history.state, '', targetHash);
  return true;
}
