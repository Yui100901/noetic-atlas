import { Filesystem, Directory } from '@capacitor/filesystem';
import type { DurableStorage } from './runtime';
import type { SQLiteRecoveryBackup } from '../shared/models/sqlite-restore';

const MAIN = 'learning.sqlite'; const PREVIOUS = 'learning.previous.sqlite'; const TEMP = 'learning.next.sqlite';
const RECOVERY_INDEX = 'learning.restore-backup.json';
const sameBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length && left.every((value, index) => value === right[index]);
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
function recoveryPath(id: string) { if (!/^before-restore-[0-9T.Z-]+-[a-f0-9-]+$/.test(id)) throw new Error('恢复前副本标识无效'); return `${id}.sqlite`; }

return {
  async load() {
    if (await exists(MAIN)) return read(MAIN);
    // A process can stop between the two renames: recover the last committed DB.
    if (await exists(PREVIOUS)) { const bytes = await read(PREVIOUS); await rename(PREVIOUS, MAIN); return bytes; }
    return undefined;
  },
  async save(bytes) {
    await filesystem.writeFile({ directory: Directory.Data, path: TEMP, data: bytesToBase64(bytes) });
    if (!sameBytes(await read(TEMP), bytes)) throw new Error('写入的数据库副本不完整');
    const hadMain = await exists(MAIN);
    if (hadMain) {
      if (await exists(PREVIOUS)) await filesystem.deleteFile({ directory: Directory.Data, path: PREVIOUS });
      await rename(MAIN, PREVIOUS);
    }
    try { await rename(TEMP, MAIN); if (!sameBytes(await read(MAIN), bytes)) throw new Error('数据库提交校验失败'); }
    catch (error) {
      // Never report success on partial persistence; restore disk before caller
      // restores the live SQLite snapshot. Keep PREVIOUS if recovery itself fails.
      if (hadMain && await exists(PREVIOUS)) { if (await exists(MAIN)) await filesystem.deleteFile({ directory: Directory.Data, path: MAIN }); await rename(PREVIOUS, MAIN); }
      else if (!hadMain && await exists(MAIN)) await filesystem.deleteFile({ directory: Directory.Data, path: MAIN });
      throw error;
    }
  },
  async createRecoveryBackup(bytes) {
    const createdAt = new Date().toISOString();
    const backup: SQLiteRecoveryBackup = { id: `before-restore-${createdAt.replaceAll(':', '-')}-${crypto.randomUUID()}`, createdAt, byteLength: bytes.length };
    const path = recoveryPath(backup.id);
    // This is independent of PREVIOUS. Ordinary future saves must never rotate
    // away the one complete copy from before a destructive database replacement.
    await filesystem.writeFile({ directory: Directory.Data, path, data: bytesToBase64(bytes) });
    if (!sameBytes(await read(path), bytes)) throw new Error('恢复前副本写入不完整，已取消恢复');
    await filesystem.writeFile({ directory: Directory.Data, path: RECOVERY_INDEX, data: bytesToBase64(new TextEncoder().encode(JSON.stringify(backup))) });
    return backup;
  },
  async loadRecoveryBackup(id) { return read(recoveryPath(id)); },
  async latestRecoveryBackup() {
    if (!await exists(RECOVERY_INDEX)) return undefined;
    const value = JSON.parse(new TextDecoder().decode(await read(RECOVERY_INDEX))) as SQLiteRecoveryBackup;
    if (typeof value.id !== 'string' || typeof value.createdAt !== 'string' || !Number.isSafeInteger(value.byteLength) || !await exists(recoveryPath(value.id))) throw new Error('恢复前副本索引无效');
    return value;
  },
};
}
export const deviceStorage = createDeviceStorage();
