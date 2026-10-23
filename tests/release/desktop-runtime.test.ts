import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { learningSeed } from '../fixtures/learning-seed.js';
const require = createRequire(import.meta.url);
const { preparePaths, isLocalNavigation, isAllowedDownload, launchServer } = require('../../desktop/runtime.cjs');
const root = resolve(import.meta.dirname, '../..');
const execute = promisify(execFile);

async function fixture(t: test.TestContext, realServer = false) {
  const directory = await mkdtemp(join(tmpdir(), 'noetic-desktop-test-'));
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(directory.includes('noetic-desktop-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const resources = join(directory, 'resources'), serverRoot = join(resources, 'server');
  await mkdir(join(resources, 'node'), { recursive: true });
  await mkdir(join(serverRoot, 'desktop'), { recursive: true });
  await mkdir(join(serverRoot, 'data'), { recursive: true });
  await copyFile(process.execPath, join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node'));
  await copyFile(join(root, 'desktop/server.mjs'), join(serverRoot, 'desktop/server.mjs'));
  await writeFile(join(serverRoot, 'package.json'), '{"type":"module"}');
  if (realServer) {
    // Compile the actual application into this fixture. npm test must work in
    // a fresh source checkout, and parallel QA must never mutate shared dist.
    await execute(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.server.json'), '--outDir', join(serverRoot, 'dist')], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    await mkdir(join(serverRoot, 'dist/web'), { recursive: true });
    await writeFile(join(serverRoot, 'dist/web/index.html'), '<!doctype html><html><head><title>认知星图 portable fixture</title></head><body>Portable test</body></html>');
    // A directory junction does not require symlink privileges on Windows.
    await symlink(join(root, 'node_modules'), join(serverRoot, 'node_modules'), 'junction');
    // A stale operator file inside resources must never be loaded implicitly.
    await writeFile(join(serverRoot, 'data/seed.json'), JSON.stringify(learningSeed()));
  } else {
    await mkdir(join(serverRoot, 'dist/server'), { recursive: true });
    await mkdir(join(serverRoot, 'dist/web'), { recursive: true });
    await writeFile(join(serverRoot, 'dist/server/index.js'), 'export function buildApp() { throw new Error("fixture bootstrap error"); }');
    await writeFile(join(serverRoot, 'dist/web/index.html'), '<!doctype html><title>Fixture</title>');
    await writeFile(join(serverRoot, 'data/seed.json'), '{}');
  }
  return { directory, resources, serverRoot, cleanup };
}

test('portable data directory stays outside immutable runtime resources and reports invalid paths clearly', async t => {
  const files = await fixture(t);
  const paths = preparePaths({ execPath: join(files.directory, 'noetic-atlas.exe'), resourcesPath: files.resources, env: {} });
  assert.equal(paths.dataDirectory.toLowerCase(), join(files.directory, 'data').toLowerCase());
  assert.equal(existsSync(paths.databasePath), false, 'path preparation never copies a personal database');
  assert.ok(existsSync(join(paths.dataDirectory, 'desktop/browser')));
  assert.throws(() => preparePaths({ resourcesPath: files.resources, portableRoot: files.directory, env: { NOETIC_ATLAS_DATA_DIR: 'relative-data' } }), { code: 'INVALID_DATA_DIRECTORY' });
  assert.throws(() => preparePaths({ resourcesPath: files.resources, portableRoot: files.directory, env: { NOETIC_ATLAS_DATA_DIR: join(files.resources, 'server/data') } }), { code: 'INVALID_DATA_DIRECTORY' });
  assert.throws(() => preparePaths({ resourcesPath: files.resources, portableRoot: files.directory, env: { NOETIC_ATLAS_DATA_DIR: files.directory } }), { code: 'INVALID_DATA_DIRECTORY' });
  const blocked = join(files.directory, 'not-a-directory'); await writeFile(blocked, 'file');
  assert.throws(() => preparePaths({ resourcesPath: files.resources, portableRoot: files.directory, env: { NOETIC_ATLAS_DATA_DIR: blocked } }), { code: 'DATA_DIRECTORY_NOT_WRITABLE' });
});

test('desktop origin checks prevent external navigation but preserve local Blob downloads', () => {
  const origin = 'http://127.0.0.1:40201';
  assert.equal(isLocalNavigation(`${origin}/#/papers`, origin), true);
  for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'http://127.0.0.1.evil.test:40201', 'http://localhost:40201', 'http://127.0.0.1:40202', 'http://user@127.0.0.1:40201']) assert.equal(isLocalNavigation(url, origin), false, url);
  assert.equal(isAllowedDownload(`${origin}/api/export`, origin), true);
  assert.equal(isAllowedDownload(`blob:${origin}/a-b-c`, origin), true);
  assert.equal(isAllowedDownload('blob:https://example.com/a-b-c', origin), false);
  assert.equal(isAllowedDownload('data:text/html,hi', origin), false);
});

test('desktop bootstrap failures stop the child and expose no exception or settings content', async t => {
  const files = await fixture(t);
  const paths = preparePaths({ resourcesPath: files.resources, portableRoot: files.directory, env: {} });
  await assert.rejects(launchServer(paths, { timeoutMs: 10000 }), (error: any) => error.code === 'SERVER_START_FAILED' && !error.message.includes('fixture bootstrap error'));
});

test('bundled standalone Node starts empty, serves UI/docs, imports content explicitly and resumes the same portable database', async t => {
  const files = await fixture(t, true);
  const paths = preparePaths({ resourcesPath: files.resources, portableRoot: files.directory, env: {} });
  let unexpected = 0;
  let service = await launchServer(paths, { onUnexpectedExit: () => unexpected++ });
  files.cleanup.push(() => service.close());
  const origin = service.origin;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const bootstrap = await (await fetch(`${origin}/api/bootstrap`)).json() as any;
  const seed = learningSeed();
  assert.equal(bootstrap.stats.totalQuestions, 0, 'portable runtime never implicitly loads a seed from immutable resources');
  assert.equal(bootstrap.stats.personalQuestions, 0);
  assert.equal(bootstrap.stats.totalDocuments, 0);
  assert.equal(bootstrap.stats.totalPapers, 0);
  const ai = await (await fetch(`${origin}/api/ai/settings`)).json() as any;
  assert.equal(ai.enabled, false); assert.equal(ai.hasKey, false);
  assert.match(await (await fetch(origin)).text(), /<html/);
  assert.equal((await fetch(`${origin}/api/docs/`)).status, 200);
  const imported = await fetch(`${origin}/api/import`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ mode: 'merge', data: seed }) });
  assert.equal(imported.status, 200);
  assert.equal(((await (await fetch(`${origin}/api/bootstrap`)).json()) as any).stats.totalQuestions, seed.questions.length);
  const questionId = seed.questions[0]!.id;
  const response = await fetch(`${origin}/api/study/${encodeURIComponent(questionId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ favorite: true, notes: 'portable restart persistence check' }) });
  assert.equal(response.status, 200);
  await service.close(); await service.close();
  assert.equal(unexpected, 0);
  await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) }));
  service = await launchServer(paths, { onUnexpectedExit: () => unexpected++ });
  const study = await (await fetch(`${service.origin}/api/study`)).json() as any;
  assert.ok(study.items.some((item: any) => item.questionId === questionId && item.favorite && item.notes === 'portable restart persistence check'));
  await service.close(); assert.equal(unexpected, 0);
});
