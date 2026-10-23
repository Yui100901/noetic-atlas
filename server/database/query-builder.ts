import { Kysely, DummyDriver, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from 'kysely';
import type { AtlasDatabase } from './schema.js';

export type DatabaseDialect = 'sqlite' | 'postgres' | 'mysql';
/** Official compile-only mode: no connection or driver leaks into repositories. */
export function createQueryBuilder(dialect: DatabaseDialect = 'sqlite'): Kysely<AtlasDatabase> {
  const components = dialect === 'postgres'
    ? { createAdapter: () => new PostgresAdapter(), createIntrospector: (db: Kysely<any>) => new PostgresIntrospector(db), createQueryCompiler: () => new PostgresQueryCompiler() }
    : dialect === 'mysql'
      ? { createAdapter: () => new MysqlAdapter(), createIntrospector: (db: Kysely<any>) => new MysqlIntrospector(db), createQueryCompiler: () => new MysqlQueryCompiler() }
      : { createAdapter: () => new SqliteAdapter(), createIntrospector: (db: Kysely<any>) => new SqliteIntrospector(db), createQueryCompiler: () => new SqliteQueryCompiler() };
  return new Kysely<AtlasDatabase>({ dialect: { ...components, createDriver: () => new DummyDriver() } });
}
