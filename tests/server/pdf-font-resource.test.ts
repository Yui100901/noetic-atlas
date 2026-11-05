import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { decodePdfFont } from '../../web/shared/export/pdf-font.js';

test('static offline font uses an opaque binary name and keeps gzip bytes without HTTP auto-decoding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-font-resource-'));
  const original = new Uint8Array([0, 1, 0, 0, ...new Uint8Array(100)]);
  const packed = gzipSync(original);
  await writeFile(join(root, 'font.ttf.bin'), packed);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await rm(join(root, 'font.ttf.bin'));
    await rmdir(root);
  });
  await app.register(staticPlugin, { root, dotfiles: 'deny' });
  const response = await app.inject('/font.ttf.bin');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-encoding'], undefined);
  assert.deepEqual(response.rawPayload, packed);
  assert.deepEqual(await decodePdfFont(response.rawPayload), original);
});
