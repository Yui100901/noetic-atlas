let seed = '';
const temporary = new Map<string, Uint8Array>();
export const SEED_PATH = '/native/seed.json';
export function configureSeed(value: unknown) { seed = JSON.stringify(value); }
export function setVirtualFile(path: string, value: Uint8Array) { temporary.set(path, value); }
export function existsSync(path: string) { return path === SEED_PATH || temporary.has(path); }
export function readFileSync(path: string, _encoding?: string): any {
  if (path === SEED_PATH) return seed;
  const value = temporary.get(path); if (!value) throw new Error('临时文件不存在'); return value;
}
export function mkdirSync(_path: string, _options?: unknown) { /* SQLite lives in memory until the durable transaction commit. */ }
export function mkdtempSync(prefix: string) { return `${prefix}${crypto.randomUUID()}`; }
export function rmSync(path: string, _options?: unknown) { for (const key of temporary.keys()) if (key === path || key.startsWith(path + '/')) temporary.delete(key); }
