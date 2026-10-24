import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceStorage, bytesToBase64, base64ToBytes } from '../../mobile/storage.ts';

function bridge() {
  const files = new Map<string, string>(); let failCommit = false; let denied = false; let truncateWrite = false; let corruptCommit = false;
  const absent = () => { throw { code: 'OS-PLUG-FILE-0008' }; };
  const api: any = {
    async stat({ path }: any) { if (denied) throw { code: 'OS-PLUG-FILE-0007' }; if (!files.has(path)) absent(); return {}; },
    async readFile({ path }: any) { if (!files.has(path)) absent(); return { data: files.get(path) }; },
    async writeFile({ path, data }: any) { files.set(path, truncateWrite && path === 'learning.next.sqlite' ? bytesToBase64(new Uint8Array([99])) : data); },
    async deleteFile({ path }: any) { if (!files.delete(path)) absent(); },
    async rename({ from, to }: any) {
      if (failCommit && from === 'learning.next.sqlite') throw new Error('simulated failed rename');
      if (!files.has(from)) absent(); files.set(to, corruptCommit && from === 'learning.next.sqlite' ? bytesToBase64(new Uint8Array([88])) : files.get(from)!); files.delete(from);
    },
  };
  return { files, storage: createDeviceStorage(api), failCommit: () => { failCommit = true; }, deny: () => { denied = true; }, truncate: () => { truncateWrite = true; }, corrupt: () => { corruptCommit = true; } };
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

test('Android keeps a verified independent recovery copy across ordinary database rotations', async () => {
  const a = bridge(); const original = new Uint8Array([1, 2, 3, 4]);
  await a.storage.save(original);
  const backup = await a.storage.createRecoveryBackup!(original);
  assert.equal((await a.storage.latestRecoveryBackup!())!.id, backup.id);
  await a.storage.save(new Uint8Array([5, 6])); await a.storage.save(new Uint8Array([7, 8]));
  assert.deepEqual(await a.storage.loadRecoveryBackup!(backup.id), original);
  assert.ok(a.files.has(`${backup.id}.sqlite`));
  await assert.rejects(a.storage.loadRecoveryBackup!('../learning'), /标识无效/);
});

test('Android never acknowledges truncated writes or a corrupt final rename, and retains the original file', async () => {
  for (const corruptAtCommit of [false, true]) {
    const a = bridge(); const original = new Uint8Array([1, 2, 3, 4]);
    await a.storage.save(original);
    if (corruptAtCommit) a.corrupt(); else a.truncate();
    await assert.rejects(a.storage.save(new Uint8Array([6, 7, 8])), /不完整|校验失败/);
    assert.deepEqual(await a.storage.load(), original);
  }
});
