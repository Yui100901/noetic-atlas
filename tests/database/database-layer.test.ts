import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createQueryBuilder, type DatabaseDialect } from '../../server/database/query-builder.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import { recordTables, type RecordTable } from '../../server/database/schema.js';

// Official cold Kysely + DummyDriver compilation. PostgreSQL/MySQL are not executed.
// https://kysely.dev/docs/recipes/splitting-query-building-and-execution
for (const dialect of ['sqlite', 'postgres', 'mysql'] as const satisfies readonly DatabaseDialect[]) {
  test(`${dialect}: identical CRUD/filter builders use dialect quoting and bound parameters`, async () => {
    const db = createQueryBuilder(dialect), quote = dialect === 'mysql' ? '`' : '"';
    const id = "题号'); DROP TABLE questions;--", data = JSON.stringify({ title: '中文と日本語', note: id });
    const identifier = (value: string) => `${quote}${value}${quote}`;
    const placeholder = (index: number) => dialect === 'postgres' ? `$${index}` : '?';
    const table = identifier('questions'), idColumn = identifier('id'), dataColumn = identifier('data');
    try {
      const insert = db.insertInto('questions').values({ id, data }).compile();
      assert.equal(insert.sql, `insert into ${table} (${idColumn}, ${dataColumn}) values (${placeholder(1)}, ${placeholder(2)})`);
      assert.deepEqual(insert.parameters, [id, data]);
      const select = db.selectFrom('questions').select(['id', 'data']).where('id', '=', id).where('data', 'like', '%学习%').orderBy('id', 'asc').limit(20).offset(40).compile();
      assert.equal(select.sql, `select ${idColumn}, ${dataColumn} from ${table} where ${idColumn} = ${placeholder(1)} and ${dataColumn} like ${placeholder(2)} order by ${idColumn} asc limit ${placeholder(3)} offset ${placeholder(4)}`);
      assert.deepEqual(select.parameters, [id, '%学习%', 20, 40]);
      const update = db.updateTable('questions').set({ data }).where('id', '=', id).compile();
      assert.equal(update.sql, `update ${table} set ${dataColumn} = ${placeholder(1)} where ${idColumn} = ${placeholder(2)}`);
      assert.deepEqual(update.parameters, [data, id]);
      const remove = db.deleteFrom('questions').where('id', '=', id).compile();
      assert.equal(remove.sql, `delete from ${table} where ${idColumn} = ${placeholder(1)}`);
      assert.deepEqual(remove.parameters, [id]);
      for (const query of [insert, select, update, remove]) {
        assert.ok(!query.sql.includes(id), `${dialect} must not inline malicious input`);
        assert.ok(!query.sql.includes('中文と日本語'), `${dialect} must not inline JSON data`);
      }
    } finally { await db.destroy(); }
  });
}

test('dynamic identifiers are quoted, but repository methods still enforce a runtime table allowlist', async () => {
  const query = createQueryBuilder(), unsafeTable = 'questions"; DROP TABLE questions;--';
  try {
    // The compiler correctly treats this as one identifier. Quoting alone cannot
    // authorize a table: external input must never select another existing table.
    const compiled = query.selectFrom(unsafeTable as 'questions').select('id').compile();
    assert.equal(compiled.sql, 'select "id" from "questions""; DROP TABLE questions;--"');
    assert.deepEqual(compiled.parameters, []);
  } finally { await query.destroy(); }
  const database = new DatabaseConnection(':memory:');
  try {
    database.putRecord('questions', 'safe', { id: 'safe', title: '保留的数据' });
    for (const name of [unsafeTable, 'metadata', 'sqlite_master', 'not_a_record_table']) {
      const table = name as RecordTable;
      for (const operation of [
        () => database.records(table), () => database.getRecord(table, 'safe'),
        () => database.putRecord(table, 'unsafe', {}), () => database.deleteRecord(table, 'safe'),
      ]) assert.throws(operation, /(?:Invalid|Unsupported|Unknown) (?:database|record) table|无效.*表|不支持.*表/i);
    }
    assert.equal(database.getRecord<{ title: string }>('questions', 'safe')?.title, '保留的数据');
  } finally { database.close(); }
});

test('SQLite repository executes bound CRUD and literal Unicode/JSON filters', () => {
  const database = new DatabaseConnection(':memory:'), query = database.query, expressions = database.expressions;
  const malicious = "x'); DELETE FROM questions;--";
  try {
    database.putRecord('questions', malicious, { id: malicious, title: 'ÉCOLE 南京 日本語 100%_完成', tagIds: ['中文', malicious], count: 1 });
    database.putRecord('questions', 'second', { id: 'second', title: '其他内容', tagIds: ['中文', '练习'], count: 2 });
    assert.equal(database.getRecord<{ count: number }>('questions', malicious)?.count, 1);
    const title = expressions.field<string>('data', 'title');
    const insensitive = database.all(query.selectFrom('questions').select('id').where(expressions.unicodeContains(title, 'école 南京 日本語')));
    assert.deepEqual(insensitive.map(row => row.id), [malicious]);
    const literal = database.all(query.selectFrom('questions').select('id').where(expressions.containsLiteral(title, '%_')));
    assert.deepEqual(literal.map(row => row.id), [malicious]);
    const tagged = database.all(query.selectFrom('questions').select('id').where(expressions.arrayAll('data', 'tagIds', ['中文', malicious])));
    assert.deepEqual(tagged.map(row => row.id), [malicious]);
    const maliciousQuery = query.selectFrom('questions').select('id').where(expressions.arrayAny('data', 'tagIds', [malicious])).compile();
    assert.ok(!maliciousQuery.sql.includes(malicious));
    assert.ok(maliciousQuery.parameters.includes(JSON.stringify([malicious])));
    assert.throws(() => expressions.field('data', "title'); DROP TABLE questions;--"), /Invalid database field/);
    database.putRecord('questions', malicious, { id: malicious, title: '更新后的内容', count: 3 });
    assert.equal(database.records('questions').length, 2);
    assert.equal(database.getRecord<{ count: number }>('questions', malicious)?.count, 3);
    database.deleteRecord('questions', malicious);
    assert.equal(database.getRecord('questions', malicious), undefined);
    assert.equal(database.records('questions').length, 1);
  } finally { database.close(); }
});

test('SQLite nested savepoints commit correctly and roll back at the appropriate level', () => {
  const database = new DatabaseConnection(':memory:');
  try {
    const outerError = new Error('outer rollback');
    assert.throws(() => database.transaction(() => {
      database.putRecord('questions', 'outer-failed', { id: 'outer-failed' });
      database.transaction(() => database.transaction(() => database.putRecord('questions', 'inner-committed', { id: 'inner-committed' })));
      throw outerError;
    }), error => error === outerError);
    assert.deepEqual(database.records('questions'), []);
    const result = database.transaction(() => {
      database.putRecord('questions', 'outer-kept', { id: 'outer-kept' });
      assert.throws(() => database.transaction(() => {
        database.putRecord('questions', 'inner-failed', { id: 'inner-failed' });
        database.transaction(() => database.putRecord('questions', 'deep-failed', { id: 'deep-failed' }));
        throw new Error('inner rollback');
      }), /inner rollback/);
      database.transaction(() => database.transaction(() => database.putRecord('questions', 'deep-kept', { id: 'deep-kept' })));
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(database.records<{ id: string }>('questions').map(row => row.id).sort(), ['deep-kept', 'outer-kept']);
    assert.equal(database.getRecord('questions', 'inner-failed'), undefined);
    assert.equal(database.getRecord('questions', 'deep-failed'), undefined);
  } finally { database.close(); }
});

test('SQLite initialization is idempotent across reopens and retains Unicode records', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'atlas-database-layer-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'records.sqlite'), original = { id: '中文-かな-É', title: '学习📚 / 日本語 / naïve', nested: { value: null, tags: ['知识', '概念'] } };
  let database = new DatabaseConnection(path);
  try {
    for (const table of recordTables) assert.ok(database.hasTable(table));
    database.putRecord('questions', original.id, original);
    assert.deepEqual(database.getRecord('questions', original.id), original);
  } finally { database.close(); }
  for (let index = 0; index < 2; index++) {
    database = new DatabaseConnection(path);
    try {
      assert.deepEqual(database.getRecord('questions', original.id), original);
      const metadata = database.all(database.query.selectFrom('metadata').selectAll().where('key', '=', 'schema_version'));
      assert.deepEqual(metadata.map(row => ({ ...row })), [{ key: 'schema_version', value: '1' }]);
      assert.equal(database.records('questions').length, 1);
    } finally { database.close(); }
  }
});

test('server services cannot import node:sqlite or call native .db.prepare/.db.exec', async () => {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../server'), violations: string[] = [];
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (path !== join(serverRoot, 'database')) await inspect(path); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const report = (node: ts.Node, message: string) => violations.push(`${relative(serverRoot, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${message}`);
      const native = (node: ts.Node | undefined) => node && ts.isStringLiteral(node) && node.text === 'node:sqlite';
      function visit(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && native(node.moduleSpecifier)) report(node, 'native driver import');
        if (ts.isCallExpression(node)) {
          if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && native(node.arguments[0])) report(node, 'native driver dynamic import');
          const method = node.expression;
          if (ts.isPropertyAccessExpression(method) && ['prepare', 'exec'].includes(method.name.text) && ts.isPropertyAccessExpression(method.expression) && ['db', 'database'].includes(method.expression.name.text)) report(node, 'native SQL execution outside database layer');
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  await inspect(serverRoot);
  assert.deepEqual(violations, [], violations.join('\n'));
});
