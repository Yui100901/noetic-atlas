/** Cache compiled Android code, never an initialized runtime or user storage. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const projectRoot = resolve(import.meta.dirname, '../..');
const helperVersion = 'native-runtime-cache-v1';

/** Hash actual source and dependency lock contents, not mtimes. Generated assets
 * and private data are deliberately outside this dependency set. */
export async function nativeRuntimeFingerprint(root = projectRoot) {
  const digest = createHash('sha256').update(helperVersion).update(process.versions.node);
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      // Only mobile/assets is generated. server/modules/assets contains real
      // attachment business rules and must invalidate the compiled runtime.
      if (path === join(root, 'mobile/assets') || ['node_modules', 'dist'].includes(entry.name))
        continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:[cm]?js|tsx?|json)$/.test(entry.name)) {
        digest
          .update(relative(root, path).replaceAll('\\', '/'))
          .update('\0')
          .update(await readFile(path))
          .update('\0');
      }
    }
  }
  for (const directory of ['mobile', 'server', 'shared']) await visit(join(root, directory));
  for (const file of ['package.json', 'package-lock.json'])
    digest.update(file).update(await readFile(join(root, file)));
  digest.update(await readFile(new URL(import.meta.url)));
  return digest.digest('hex');
}

function withinCache(cacheRoot, path) {
  const child = relative(cacheRoot, path);
  if (!child || child.startsWith('..') || isAbsolute(child))
    throw new Error('Invalid native test cache path');
  return path;
}

async function completeBundle(directory, fingerprint) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const bundle = join(directory, 'runtime.mjs');
    return manifest.fingerprint === fingerprint && (await stat(bundle)).size > 0
      ? bundle
      : undefined;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError)
      return undefined;
    throw error;
  }
}

async function compileRuntime(root, destination) {
  const [{ build }, { nativeAliases }] = await Promise.all([
    import('vite'),
    import(pathToFileURL(join(root, 'mobile/vite-aliases.ts')).href),
  ]);
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    define: { 'process.env': '{}' },
    resolve: { alias: nativeAliases },
    build: {
      outDir: destination,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(root, 'mobile/runtime.ts'),
        formats: ['es'],
        fileName: () => 'runtime.mjs',
      },
    },
  });
}

/** The parent test runner builds once; direct single-file test commands use the
 * same fallback. An exclusive directory lock and atomic rename prevent readers
 * from importing a partially written bundle when several runners start at once.
 * compile is injectable only to exercise this cache protocol without Vite. */
export async function prepareNativeRuntimeBundle({
  root = projectRoot,
  cacheRoot = join(root, 'test-results/cache/native-runtime'),
  compile = compileRuntime,
  timeoutMs = 180_000,
} = {}) {
  root = resolve(root);
  cacheRoot = resolve(cacheRoot);
  const fingerprint = await nativeRuntimeFingerprint(root);
  const destination = withinCache(cacheRoot, join(cacheRoot, fingerprint));
  const existing = await completeBundle(destination, fingerprint);
  if (existing) return existing;
  await mkdir(cacheRoot, { recursive: true });
  const lock = withinCache(cacheRoot, destination + '.lock'),
    token = randomUUID();
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ready = await completeBundle(destination, fingerprint);
      if (ready) return ready;
      // Never steal/delete another builder's lock. A killed process may leave a
      // lock; report its path so an operator can remove it after checking jobs.
      if (Date.now() - started > timeoutMs)
        throw new Error(
          `Timed out waiting for native test bundle; check active builders before removing ${lock}`,
        );
      await delay(100);
    }
  }
  const temporary = withinCache(cacheRoot, join(cacheRoot, `${fingerprint}.building-${token}`));
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }));
    const ready = await completeBundle(destination, fingerprint);
    if (ready) return ready;
    await mkdir(temporary);
    await compile(root, temporary);
    if (!(await stat(join(temporary, 'runtime.mjs'))).size)
      throw new Error('Native test bundle is empty');
    await writeFile(
      join(temporary, 'manifest.json'),
      JSON.stringify({ fingerprint, createdAt: new Date().toISOString(), node: process.version }),
    );
    // A previous incomplete cache entry is never a usable bundle.
    await rm(withinCache(cacheRoot, destination), { recursive: true, force: true });
    await rename(temporary, destination);
    return join(destination, 'runtime.mjs');
  } finally {
    await rm(withinCache(cacheRoot, temporary), { recursive: true, force: true });
    await rm(withinCache(cacheRoot, lock), { recursive: true, force: true });
  }
}

let prepared;
export function getNativeRuntimeBundle() {
  if (!prepared)
    prepared = (async () => {
      const provided = process.env.NOETIC_NATIVE_TEST_BUNDLE;
      if (!provided) return prepareNativeRuntimeBundle();
      if (!isAbsolute(provided) || !(await stat(provided)).isFile())
        throw new Error('NOETIC_NATIVE_TEST_BUNDLE must point to a prebuilt absolute module path');
      return provided;
    })();
  return prepared;
}
