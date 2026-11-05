/** The browser is already compiled in dist/web. Only install packages actually
 * referenced by compiled Node/shared modules; npm retains each full dependency
 * closure and package resource directories (Swagger UI, KaTeX, etc.). */
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isBuiltin } from 'node:module';
import { sourceFiles, parseDependencies } from '../testing/source-dependencies.mjs';

export async function windowsServerDependencies(root, packageJson, packageLock) {
  const names = new Set();
  for (const directory of ['server', 'shared']) {
    for (const file of sourceFiles(join(root, 'dist', directory))) {
      if (!/\.[cm]?js$/.test(file)) continue;
      const references = parseDependencies(file, await readFile(file, 'utf8'), {
        rejectDynamicModules: true,
      });
      for (const { specifier, asset } of references) {
        if (asset || specifier.startsWith('.') || isBuiltin(specifier)) continue;
        if (specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':'))
          throw new Error(`Windows服务依赖无法静态确定：${relative(root, file)} → ${specifier}`);
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : specifier.split('/')[0];
        if (!Object.hasOwn(packageJson.dependencies || {}, name))
          throw new Error(`Windows服务引用未声明的生产依赖：${name}`);
        if (!packageLock.packages?.[`node_modules/${name}`]?.integrity)
          throw new Error(`Windows服务依赖缺少锁定校验：${name}`);
        names.add(name);
      }
    }
  }
  if (!names.size) throw new Error('未找到编译后的Windows服务依赖，请先完整构建');
  const dependencies = Object.fromEntries(
    [...names].sort().map((name) => [name, packageJson.dependencies[name]]),
  );
  const manifest = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    type: 'module',
    ...(packageJson.engines ? { engines: packageJson.engines } : {}),
    dependencies,
    ...(packageJson.overrides ? { overrides: packageJson.overrides } : {}),
  };
  // Keep registry URLs, exact versions, integrity and nested package placement.
  // This projection is intermediate: npm must normalize the lock offline,
  // then validate every pinned object before npm ci (old production-marked
  // orphan records would otherwise still be materialized).
  const lock = structuredClone(packageLock);
  lock.packages[''] = { ...lock.packages[''], dependencies };
  delete lock.packages[''].devDependencies;
  return { manifest, lock, directPackages: [...names].sort() };
}

export async function writeWindowsServerDependencies(root, destination) {
  const [manifest, lock] = await Promise.all(
    ['package.json', 'package-lock.json'].map(async (name) =>
      JSON.parse(await readFile(join(root, name), 'utf8')),
    ),
  );
  const result = await windowsServerDependencies(root, manifest, lock);
  await Promise.all([
    writeFile(join(destination, 'package.json'), JSON.stringify(result.manifest, null, 2) + '\n'),
    writeFile(join(destination, 'package-lock.json'), JSON.stringify(result.lock, null, 2) + '\n'),
  ]);
  return result.directPackages;
}

/** npm may normalize reachability flags, but must never select a version or
 * registry object outside the repository's reviewed lock. */
export function assertWindowsServerLock(original, selected) {
  for (const [path, value] of Object.entries(selected.packages || {})) {
    if (!path) continue;
    const trusted = original.packages?.[path];
    if (!trusted || ['version', 'resolved', 'integrity'].some((key) => trusted[key] !== value[key]))
      throw new Error(`Windows依赖规范化改变了锁定对象：${path}`);
  }
}
