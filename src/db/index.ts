import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import { config } from '../config.js';
import type { DB } from './types.js';

// By default pg returns int8 (bigint ids, count(*)) as strings. Our values stay far below
// 2^53, so parsing them as numbers is safe.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

/**
 * One pool per process. During a rush the pool is the bottleneck by design: at most
 * DB_POOL_MAX queries run at once, and the rest queue here, not in Postgres. A request that
 * can't get a connection within DB_CONNECT_TIMEOUT_MS fails fast (503) instead of hanging.
 */
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
  idleTimeoutMillis: 30_000,
  // Server-side safety nets: a runaway query, or a transaction someone forgot to finish
  // (holding row locks!), is cut off by Postgres itself.
  statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: 30_000,
  application_name: 'ticket-mng',
});

export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
  plugins: [new CamelCasePlugin()],
});
export type Db = typeof db;
