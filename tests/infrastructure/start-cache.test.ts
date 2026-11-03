import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { buildState, recordBuild } from '../../scripts/build/start-cache.mjs';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'atlas-start-cache-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('atlas-start-cache-'));
    await rm(root, { recursive: true, force: true });
  });
  const put = async (file: string, text: string) => {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  await put('server/main.ts', 'source');
  await put('dist/server/main.js', 'compiled');
  await put('dist/web/index.html', 'web');
  return { root, put };
}
test('startup reuses unchanged successful builds while changed/new/deleted sources invalidate them', async (t) => {
  const { root, put } = await fixture(t);
  assert.equal(buildState(root).ready, false);
  recordBuild(root);
  assert.equal(buildState(root).fresh, true);
  await utimes(join(root, 'server/main.ts'), new Date(0), new Date());
  assert.equal(
    buildState(root).fresh,
    true,
    'touch without content changes must not force a rebuild',
  );
  await put('server/main.ts', 'edited');
  assert.equal(buildState(root).fresh, false);
  assert.equal(buildState(root).ready, true, 'explicit fast mode can use an intact last build');
  recordBuild(root);
  await put('shared/new.ts', 'added');
  assert.equal(buildState(root).fresh, false);
  recordBuild(root);
  await rm(join(root, 'shared/new.ts'));
  assert.equal(buildState(root).fresh, false);
});
test('partial outputs and corrupted records cannot masquerade as a successful build', async (t) => {
  const { root, put } = await fixture(t);
  recordBuild(root);
  await put('dist/server/main.js', 'broken');
  assert.equal(buildState(root).ready, false);
  recordBuild(root);
  await rm(join(root, 'dist/web/index.html'));
  assert.equal(buildState(root).ready, false);
  assert.throws(() => recordBuild(root), /构建未完成/);
  await put('dist/web/index.html', 'web');
  await put('dist/.startup-cache.json', 'incomplete');
  assert.equal(buildState(root).ready, false);
});
test('user databases, backups and private configuration never invalidate the program build', async (t) => {
  const { root, put } = await fixture(t);
  recordBuild(root);
  await put('data/database.sqlite', 'private');
  await put('config/local.json', 'private');
  await put('test-results/history.json', 'private');
  assert.equal(buildState(root).fresh, true);
  await put('config/defaults.json', 'base configuration changed');
  assert.equal(buildState(root).fresh, false);
});
