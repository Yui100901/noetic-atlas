import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { verifyQaAssets } from '../../scripts/testing/android/verify-assets.mjs';

async function fixture(t: test.TestContext) {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-apk-assets-'));
  t.after(async () => {
    assert.equal(dirname(folder), tmpdir());
    await rm(folder, { recursive: true, force: true });
  });
  await mkdir(join(folder, 'fonts'));
  await mkdir(join(folder, 'assets'));
  const font = new Uint8Array([0x1f, 0x8b, 8, 0]);
  const metadata = strToU8(JSON.stringify({ package: 'cn.noetic.atlas.qa' }));
  await writeFile(join(folder, 'fonts/NotoSansSC-Regular.ttf.bin'), font);
  await writeFile(join(folder, 'qa-entry.json'), metadata);
  await writeFile(join(folder, 'assets/使用说明书.js'), 'export default "说明"');
  return {
    folder,
    entries: {
      'assets/public/fonts/NotoSansSC-Regular.ttf.bin': font,
      'assets/public/qa-entry.json': metadata,
      'assets/public/assets/使用说明书.js': strToU8('export default "说明"'),
    },
  };
}

test('QA APK assets validate UTF-8 names even when AAPT omits the ZIP UTF-8 flag', async (t) => {
  const { folder, entries } = await fixture(t),
    apk = zipSync(entries, { level: 0 });
  await verifyQaAssets(apk, folder);
  const view = new DataView(apk.buffer);
  for (let index = 0; index < apk.length - 10; index++) {
    const signature = view.getUint32(index, true);
    if (signature === 0x04034b50)
      view.setUint16(index + 6, view.getUint16(index + 6, true) & ~2048, true);
    if (signature === 0x02014b50)
      view.setUint16(index + 8, view.getUint16(index + 8, true) & ~2048, true);
  }
  await verifyQaAssets(apk, folder);
});

test('QA APK validation rejects stale merged files and altered compressed font bytes', async (t) => {
  const { folder, entries } = await fixture(t);
  await assert.rejects(
    verifyQaAssets(
      zipSync({ ...entries, 'assets/public/fonts/old.ttf': strToU8('stale') }),
      folder,
    ),
    /Stale file/,
  );
  await assert.rejects(
    verifyQaAssets(
      zipSync({ ...entries, 'assets/public/fonts/NotoSansSC-Regular.ttf.bin': strToU8('changed') }),
      folder,
    ),
    /AAPT changed/,
  );
});
