import { Filesystem, Directory } from '@capacitor/filesystem';
import type { DurableStorage } from './runtime';

const MAIN = 'learning.sqlite'; const PREVIOUS = 'learning.previous.sqlite'; const TEMP = 'learning.next.sqlite';
export function bytesToBase64(bytes: Uint8Array): string { let value = ''; for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(value); }
export function base64ToBytes(value: string) { const binary = atob(value); return Uint8Array.from(binary, ch => ch.charCodeAt(0)); }
export function createDeviceStorage(filesystem: Pick<typeof Filesystem, 'stat' | 'readFile' | 'writeFile' | 'deleteFile' | 'rename'> = Filesystem): DurableStorage {
async function exists(path: string) {
  try { await filesystem.stat({ directory: Directory.Data, path }); return true; }
  catch (error) {
    // Permission and I/O failures must never look like a first install: that
    // could otherwise replace existing learning records with the built-in seed.
    if ((error as { code?: string }).code === 'OS-PLUG-FILE-0008') return false;
    throw error;
  }
}
async function read(path: string) { const value = await filesystem.readFile({ directory: Directory.Data, path }); if (typeof value.data !== 'string') return new Uint8Array(await value.data.arrayBuffer()); return base64ToBytes(value.data); }
async function rename(from: string, to: string) { await filesystem.rename({ from, to, directory: Directory.Data, toDirectory: Directory.Data }); }

return {
  async load() {
    if (await exists(MAIN)) return read(MAIN);
    // A process can stop between the two renames: recover the last committed DB.
    if (await exists(PREVIOUS)) { const bytes = await read(PREVIOUS); await rename(PREVIOUS, MAIN); return bytes; }
    return undefined;
  },
  async save(bytes) {
    await filesystem.writeFile({ directory: Directory.Data, path: TEMP, data: bytesToBase64(bytes) });
    const hadMain = await exists(MAIN);
    if (hadMain) {
      if (await exists(PREVIOUS)) await filesystem.deleteFile({ directory: Directory.Data, path: PREVIOUS });
      await rename(MAIN, PREVIOUS);
    }
    try { await rename(TEMP, MAIN); }
    catch (error) {
      // Never report success on partial persistence; restore disk before caller
      // restores the live SQLite snapshot. Keep PREVIOUS if recovery itself fails.
      if (hadMain && !await exists(MAIN) && await exists(PREVIOUS)) await rename(PREVIOUS, MAIN);
      throw error;
    }
  },
};
}
export const deviceStorage = createDeviceStorage();
