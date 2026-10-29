import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { buildApp } from '../../server/index.js';
import { questionQuerySchema } from '../../server/modules/questions/query-schema.js';
import { taxonomyQuerySchema } from '../../server/modules/taxonomy/schema.js';
import { assetListQuerySchema } from '../../server/modules/assets/schema.js';
import { questionFeedbackQuerySchema } from '../../server/modules/quality-feedback/schema.js';
import {
  completedAiResultSchemas,
  completedAiRunMetadataSchema,
} from '../../server/modules/ai/run-schema.js';

const root = resolve(import.meta.dirname, '../..');
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(directory, entry.name)]
        : [],
  );
}

test('asset, library and settings HTTP adapters are not service dependencies', () => {
  const violations: string[] = [];
  for (const file of [
    ...sourceFiles(join(root, 'server/modules')),
    ...sourceFiles(join(root, 'mobile')),
  ]) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      if (
        !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      if (/(?:assets|library|settings)\/routes(?:\.js)?$/.test(statement.moduleSpecifier.text))
        violations.push(file + ': ' + statement.moduleSpecifier.text);
    }
  }
  assert.deepEqual(violations, []);
  for (const module of ['assets', 'library', 'settings']) {
    const source = ts.createSourceFile(
      module,
      readFileSync(join(root, 'server/modules', module, 'routes.ts'), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const exports = source.statements.filter(
      (statement) =>
        ts.canHaveModifiers(statement) &&
        ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    );
    assert.equal(exports.length, 1, module + ' routes should export registration only');
    assert.ok(
      ts.isFunctionDeclaration(exports[0]!) && exports[0].name?.text.startsWith('register'),
    );
  }
});

test('OpenAPI input bounds and AI stored result catalog use the canonical validators', async (t) => {
  const app = await buildApp({
    databasePath: ':memory:',
    seedPath: 'missing-service-contract-seed',
    staticRoot: 'missing-service-contract-web',
    native: true,
    dailyPushScheduler: false,
  });
  t.after(() => app.close());
  const response = await app.inject('/api/openapi.json');
  assert.equal(response.statusCode, 200);
  const spec = response.json();
  assert.equal(
    spec.info.version,
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  );
  for (const [path, schema] of [
    ['/api/questions', questionQuerySchema],
    ['/api/categories', taxonomyQuerySchema],
    ['/api/assets', assetListQuerySchema],
    ['/api/question-feedback', questionFeedbackQuerySchema],
  ] as const) {
    const expected = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    const actual = Object.fromEntries(
      spec.paths[path].get.parameters
        .filter((parameter: any) => parameter.in === 'query')
        .map((parameter: any) => [parameter.name, parameter.schema]),
    );
    assert.deepEqual(
      actual,
      expected.properties,
      path + ' documentation must match every bound and default',
    );
  }
  const completed = spec.components.schemas.AiRun.oneOf[0];
  const metadata = z.toJSONSchema(completedAiRunMetadataSchema.omit({ _context: true }), {
    io: 'input',
    unrepresentable: 'any',
  });
  assert.deepEqual(completed.required, metadata.required);
  assert.ok(!('_context' in completed.properties));
  assert.deepEqual(completed.properties.kind.enum, Object.keys(completedAiResultSchemas));
  assert.deepEqual(
    completed.properties.result.oneOf,
    Object.values(completedAiResultSchemas).map((schema) => {
      const { $schema: _schema, ...result } = z.toJSONSchema(schema, {
        io: 'input',
        unrepresentable: 'any',
      });
      return result;
    }),
  );
});
