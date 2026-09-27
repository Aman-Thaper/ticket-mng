import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator, type MigrationResultSet } from 'kysely/migration';

const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Migrator is schema-agnostic
export function createMigrator(db: Kysely<any>) {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
}

export function assertMigrationsOk({ error, results }: MigrationResultSet) {
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration failed: ${r.migrationName}`);
  }
  if (error) throw error instanceof Error ? error : new Error('Migration failed', { cause: error });
}
