import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { config } from '../config.js';
import type { DB } from './types.js';

// By default pg returns int8 (bigint ids, count(*)) as strings. Our values stay far below
// 2^53, so parsing them as numbers is safe.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createDb(connectionString = config.DATABASE_URL) {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max: config.DB_POOL_MAX }),
    }),
    plugins: [new CamelCasePlugin()],
  });
}

export const db = createDb();
export type Db = typeof db;
