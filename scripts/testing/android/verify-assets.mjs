import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

/** AAPT emits UTF-8 paths but may omit the ZIP UTF-8 flag. Only reinterpret a
 * path when its normal spelling is absent from this owned Vite output. */
export async function verifyQaAssets(apkBytes, sourceRoot) {
  const fontPath = 'fonts/NotoSansSC-Regular.ttf.bin';
  const assets = unzipSync(apkBytes, {
    filter(file) {
      if (file.name.startsWith('assets/public/') && !file.name.endsWith('/')) {
        const name = file.name.slice('assets/public/'.length);
        let source = join(sourceRoot, name);
        if (!existsSync(source) && [...name].every((char) => char.charCodeAt(0) <= 255)) {
          try {
            source = join(
              sourceRoot,
              new TextDecoder('utf-8', { fatal: true }).decode(
                Uint8Array.from(name, (char) => char.charCodeAt(0)),
              ),
            );
          } catch {
            /* Keep the original missing path. */
          }
        }
        assert.ok(existsSync(source), 'Stale file in QA APK: ' + file.name);
      }
      return (
        file.name === 'assets/public/' + fontPath || file.name === 'assets/public/qa-entry.json'
      );
    },
  });
  assert.deepEqual(
    assets['assets/public/' + fontPath],
    new Uint8Array(await readFile(join(sourceRoot, fontPath))),
    'AAPT changed the offline font name or compressed bytes',
  );
  assert.equal(
    JSON.parse(new TextDecoder().decode(assets['assets/public/qa-entry.json'])).package,
    'cn.noetic.atlas.qa',
  );
}
