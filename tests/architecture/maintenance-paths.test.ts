import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Check root derivation without executing generators that write public data. */
test('maintenance and content tools resolve their project root after directory moves', () => {
  const root = resolve(import.meta.dirname, '../..');
  const checked: string[] = [], failures: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const visit = (node: ts.Node) => {
        if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name) && node.name.text === 'root' && node.initializer && ts.isCallExpression(node.initializer)) {
          const call = node.initializer;
          if (/(?:^|\.)resolve$/.test(call.expression.getText(source)) && call.arguments.length >= 2 && /import\.meta\.(?:dirname|url)/.test(call.arguments[0]!.getText(source)) && call.arguments.slice(1).every(ts.isStringLiteral)) {
            checked.push(relative(root, file));
            const actual = resolve(dirname(file), ...call.arguments.slice(1).map(argument => (argument as ts.StringLiteral).text));
            if (actual !== root) failures.push(`${relative(root, file)} resolves outside the project: ${actual}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(join(root, 'scripts'));
  assert.ok(checked.some(file => file.startsWith('scripts/content/')) || checked.some(file => file.startsWith('scripts\\content\\')));
  assert.ok(checked.some(file => /(?:build|release)/.test(file)));
  assert.deepEqual(failures, []);
});
