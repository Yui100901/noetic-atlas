/** Prepare source QA before stateful assertions. Production config is untouched. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:tsx?|css)$/.test(entry.name) ? [path] : [];
  }));
  return files.flat().sort();
}

function runtimeImports(file, source) {
  const imports = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const add = value => {
    if (!value || /^(?:[./\0]|@platform(?:$|\/)|node:|https?:|data:|virtual:)/.test(value) || /[?#]/.test(value)) return;
    imports.push(value);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const onlyNamedTypes = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && !clause.name && clause.namedBindings.elements.every(item => item.isTypeOnly);
      if (!clause?.isTypeOnly && !onlyNamedTypes) add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.some(item => !item.isTypeOnly)) add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast); return imports;
}

/** Include literal lazy imports too, so first Markdown use cannot restart the
 * optimizer and reload a page midway through StrictMode/count assertions. */
export async function createViteQaPreparation({ root, cacheDir, extraUrls = [] }) {
  const files = (await Promise.all(['web', 'shared'].map(folder => sourceFiles(join(root, folder))))).flat();
  const dependencies = new Set(['react/jsx-runtime', 'react/jsx-dev-runtime']);
  for (const file of files.filter(file => !file.endsWith('.css'))) for (const dependency of runtimeImports(file, await readFile(file, 'utf8'))) dependencies.add(dependency);
  const include = [...dependencies].sort();
  const urls = [...new Set([...files.map(file => '/' + relative(root, file).replaceAll('\\', '/')), ...extraUrls])];
  const diagnostics = { dependencies: include, modules: urls.length, milliseconds: null, optimizerState: null, browserHash: null, reloads: [], pendingModules: [] };
  let readyHash;
  return {
    config: { cacheDir, optimizeDeps: { include, noDiscovery: true, entries: [] } }, diagnostics,
    async ready(vite) {
      const started = performance.now(), pending = new Set(urls);
      try {
        // Vite listen awaits explicit optimization. Waiting only for the first
        // static crawl does not cover later lazy imports and source transforms.
        await vite.listen();
        const client = vite.environments.client, optimizer = client.depsOptimizer;
        assert.equal(optimizer?.initState, 'initialized', 'Explicit QA dependencies must finish before source warmup');
        const send = client.hot.send.bind(client.hot);
        client.hot.send = (...args) => { if (args[0]?.type === 'full-reload') diagnostics.reloads.push({ at: new Date().toISOString(), payload: args[0] }); return send(...args); };
        let cursor = 0;
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (cursor < urls.length) { const url = urls[cursor++]; await client.transformRequest(url); pending.delete(url); }
        }));
        await client.waitForRequestsIdle();
        diagnostics.optimizerState = optimizer.initState;
        diagnostics.browserHash = readyHash = optimizer.metadata.browserHash;
        diagnostics.milliseconds = Math.round(performance.now() - started);
        diagnostics.reloads.length = 0; // No browser/user state exists yet.
        return diagnostics;
      } finally { diagnostics.pendingModules = [...pending]; }
    },
    assertStable(vite) {
      assert.ok(readyHash, 'Source QA preparation must complete before assertions');
      assert.equal(vite.environments.client.depsOptimizer.metadata.browserHash, readyHash, 'Dependency optimizer changed during stateful QA');
      assert.deepEqual(diagnostics.reloads, [], 'Vite sent a reload during stateful QA');
    },
  };
}
