import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceStorage, bytesToBase64, base64ToBytes } from '../../mobile/storage.ts';

function bridge() {
  const files = new Map<string, string>(); let failCommit = false; let denied = false;
  const absent = () => { throw { code: 'OS-PLUG-FILE-0008' }; };
  const api: any = {
    async stat({ path }: any) { if (denied) throw { code: 'OS-PLUG-FILE-0007' }; if (!files.has(path)) absent(); return {}; },
    async readFile({ path }: any) { if (!files.has(path)) absent(); return { data: files.get(path) }; },
    async writeFile({ path, data }: any) { files.set(path, data); },
    async deleteFile({ path }: any) { if (!files.delete(path)) absent(); },
    async rename({ from, to }: any) {
      if (failCommit && from === 'learning.next.sqlite') throw new Error('simulated failed rename');
      if (!files.has(from)) absent(); files.set(to, files.get(from)!); files.delete(from);
    },
  };
  return { files, storage: createDeviceStorage(api), failCommit: () => { failCommit = true; }, deny: () => { denied = true; } };
}
test('Android file persistence restores interrupted commit and never treats I/O denial as an empty install', async () => {
  const a = bridge(); const first = new Uint8Array([0, 127, 255, 45]);
  assert.equal(await a.storage.load(), undefined); await a.storage.save(first);
  assert.deepEqual(await a.storage.load(), first);
  a.failCommit(); await assert.rejects(a.storage.save(new Uint8Array([4, 5, 6])));
  assert.deepEqual(await a.storage.load(), first, 'failed final rename restores the previous committed file');
  // Simulate termination after moving MAIN away and before committing TEMP.
  a.files.set('learning.previous.sqlite', a.files.get('learning.sqlite')!); a.files.delete('learning.sqlite');
  a.files.set('learning.next.sqlite', bytesToBase64(new Uint8Array([9])));
  assert.deepEqual(await a.storage.load(), first); assert.ok(a.files.has('learning.sqlite'));
  a.deny(); await assert.rejects(a.storage.load(), (error: any) => error.code === 'OS-PLUG-FILE-0007');
});
test('SQLite bytes use a lossless base64 bridge across chunk boundaries', () => {
  const bytes = new Uint8Array(70_001).map((_value, index) => index % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});
