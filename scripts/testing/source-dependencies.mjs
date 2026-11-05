/** First-party dependency inspection shared by architecture tests and QA.
 * Parse syntax rather than matching import-like text in comments or Markdown.
 * This module never imports application code or opens application databases. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const sourceExtensions = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
]);
const normalized = (path) => path.replaceAll('\\', '/');

export function sourceFiles(directory, excluded = new Set()) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (excluded.has(path)) return [];
    return entry.isDirectory()
      ? sourceFiles(path, excluded)
      : entry.isFile() && sourceExtensions.has(extname(entry.name))
        ? [path]
        : [];
  });
}

export function parseDependencies(file, text, { rejectDynamicModules = false } = {}) {
  if (file.endsWith('.css')) {
    // Preserve line positions while removing comments. CSS bare paths are
    // relative; data, HTTP, root URLs and fragment-only references are not.
    const content = text.replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, ' '));
    return [
      ...content.matchAll(/@import\s+['"]([^'"]+)['"]|url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/g),
    ].flatMap((match) => {
      const specifier = match[1] || match[2];
      if (!specifier || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(specifier)) return [];
      return [
        {
          specifier: specifier.startsWith('.') ? specifier : './' + specifier,
          line: content.slice(0, match.index).split('\n').length,
          asset: true,
        },
      ];
    });
  }
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(file)
      ? ts.ScriptKind.TSX
      : /\.[cm]?js$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS,
  );
  const result = [];
  const add = (node, asset = false) => {
    if (node && ts.isStringLiteralLike(node))
      result.push({
        specifier: node.text,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        ...(asset ? { asset } : {}),
      });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      add(node.argument.literal);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (rejectDynamicModules && (!argument || !ts.isStringLiteralLike(argument))) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        throw new Error(`无法静态确定模块依赖：${file}:${line}`);
      }
      add(argument);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[1]?.getText(source) === 'import.meta.url'
    )
      add(node.arguments[0], true);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

export function dependencies(file) {
  return parseDependencies(file, readFileSync(file, 'utf8'));
}

export function localTarget(importer, specifier) {
  const clean = specifier.replace(/[?#].*$/, '');
  const target = resolve(dirname(importer), clean),
    extension = extname(target);
  const candidates =
    extension === '.js'
      ? [
          target.slice(0, -3) + '.ts',
          target.slice(0, -3) + '.tsx',
          target.slice(0, -3) + '.d.ts',
          target,
        ]
      : extension === '.mjs'
        ? [target.slice(0, -4) + '.mts', target.slice(0, -4) + '.d.mts', target]
        : extension === '.cjs'
          ? [target.slice(0, -4) + '.cts', target.slice(0, -4) + '.d.cts', target]
          : extension
            ? [target]
            : [
                target,
                ...[
                  '.ts',
                  '.tsx',
                  '.js',
                  '.jsx',
                  '.mts',
                  '.mjs',
                  '.cts',
                  '.cjs',
                  '.json',
                  '.css',
                ].flatMap((suffix) => [target + suffix, join(target, 'index' + suffix)]),
              ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

export const layer = (root, path) => normalized(relative(root, path)).split('/')[0].toLowerCase();
export const diagnostic = (root, file, dependency, message) =>
  `${normalized(relative(root, file))}:${dependency.line}: ${dependency.specifier} — ${message}`;

const nativePackage = (specifier) => /^(?:@capacitor(?:\/|$)|electron(?:\/|$))/.test(specifier);
const serverPackage = (specifier) =>
  /^(?:fastify(?:\/|$)|@fastify\/|(?:better-sqlite3|sqlite3)(?:\/|$))/.test(specifier);
const databasePackage = (specifier) => /^(?:kysely|sql\.js)(?:\/|$)/.test(specifier);

/** Each exception names one build entry, not an entire source directory. */
export function boundaryViolations(root, file, dependency, target) {
  const owner = layer(root, file),
    destination = target ? layer(root, target) : undefined;
  const specifier = dependency.specifier;
  const platformAlias = specifier === '@platform' || specifier.startsWith('@platform/');
  const issues = [];
  const buildEntry = normalized(relative(root, file)) === 'mobile/vite-aliases.ts';
  const builtin = isBuiltin(specifier) || specifier.startsWith('node:');
  if (owner === 'shared') {
    if (
      builtin ||
      nativePackage(specifier) ||
      serverPackage(specifier) ||
      databasePackage(specifier) ||
      platformAlias
    )
      issues.push('shared cannot depend on a runtime or platform adapter');
    if (['server', 'web', 'mobile', 'desktop'].includes(destination))
      issues.push('shared cannot depend on an application layer');
  }
  if (owner === 'web') {
    if (
      builtin ||
      nativePackage(specifier) ||
      serverPackage(specifier) ||
      databasePackage(specifier)
    )
      issues.push('browser code must use HTTP or @platform instead of a runtime dependency');
    if (['server', 'mobile', 'desktop'].includes(destination))
      issues.push('browser code cannot import a platform implementation');
    if (platformAlias && specifier !== '@platform') issues.push('platform alias must be exact');
  }
  if (owner === 'server') {
    if (
      ['web', 'mobile', 'desktop'].includes(destination) ||
      nativePackage(specifier) ||
      platformAlias
    )
      issues.push('server must not depend on a UI or device adapter');
  }
  if (owner === 'mobile' && !buildEntry) {
    if (builtin || serverPackage(specifier) || /^electron(?:\/|$)/.test(specifier))
      issues.push(
        'mobile code must use its adapter or shared runtime instead of importing Node services',
      );
    if (['web', 'desktop'].includes(destination))
      issues.push('mobile adapter must not depend on a UI or desktop implementation');
    if (platformAlias) issues.push('mobile adapter must not import its own platform alias');
  }
  return issues.map((message) => diagnostic(root, file, dependency, message));
}

/** Cache parsing/resolution once per scan, including the transitive checks. */
export function createDependencyIndex(root) {
  root = resolve(root);
  const files = ['server', 'shared', 'web', 'mobile'].flatMap((name) =>
    sourceFiles(join(root, name), new Set([join(root, 'mobile/assets')])),
  );
  const parsed = new Map(files.map((file) => [file, dependencies(file)]));
  const targets = new Map();
  const target = (file, specifier) => {
    const key = file + '\0' + specifier;
    if (!targets.has(key)) targets.set(key, localTarget(file, specifier));
    return targets.get(key);
  };
  return { root, files, dependencies: (file) => parsed.get(file) || dependencies(file), target };
}

export function inspectBoundaries(index) {
  const violations = [],
    unresolved = [],
    counts = {};
  let references = 0;
  for (const file of index.files) {
    const owner = layer(index.root, file);
    counts[owner] = (counts[owner] || 0) + 1;
    for (const dependency of index.dependencies(file)) {
      references++;
      const target = dependency.specifier.startsWith('.')
        ? index.target(file, dependency.specifier)
        : undefined;
      if (dependency.specifier.startsWith('.') && !target)
        unresolved.push(diagnostic(index.root, file, dependency, 'local target does not exist'));
      violations.push(...boundaryViolations(index.root, file, dependency, target));
    }
  }
  return { files: counts, references, unresolved, violations };
}

/** The Android runtime reuses server services intentionally. Check all its
 * reachable first-party Node imports against the *actual* build aliases. */
export function inspectNativeGraph(index, aliases) {
  const visited = new Set(),
    violations = [],
    adaptedModules = new Set();
  const aliasTarget = (specifier) => {
    const alias = aliases.find(({ find }) =>
      typeof find === 'string'
        ? find === specifier
        : new RegExp(find.source, find.flags).test(specifier),
    );
    return (
      alias &&
      (typeof alias.find === 'string'
        ? alias.replacement
        : specifier.replace(alias.find, alias.replacement))
    );
  };
  const visit = (file) => {
    if (visited.has(file) || !sourceExtensions.has(extname(file))) return;
    visited.add(file);
    for (const dependency of index.dependencies(file)) {
      if (dependency.asset) continue;
      const specifier = dependency.specifier;
      const mapped = aliasTarget(specifier);
      if (isBuiltin(specifier) || specifier.startsWith('node:') || serverPackage(specifier)) {
        if (!mapped || !existsSync(mapped) || layer(index.root, mapped) !== 'mobile')
          violations.push(
            diagnostic(
              index.root,
              file,
              dependency,
              'Android runtime dependency has no mobile shim',
            ),
          );
        else adaptedModules.add(specifier);
      }
      const target =
        mapped || (specifier.startsWith('.') ? index.target(file, specifier) : undefined);
      if (target) visit(target);
    }
  };
  visit(join(index.root, 'mobile/platform.ts'));
  return { firstPartyFiles: visited.size, adaptedModules: [...adaptedModules].sort(), violations };
}
