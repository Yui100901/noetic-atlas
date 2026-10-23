export function join(...parts: string[]) { return parts.join('/').replace(/\/{2,}/g, '/'); }
export function resolve(...parts: string[]) { return join('/', ...parts); }
export function dirname(path: string) { return path.slice(0, path.lastIndexOf('/')) || '/'; }
export function basename(path: string) { return path.split('/').pop() || ''; }
