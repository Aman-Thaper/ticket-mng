// Usage: tsx src/db/migrate.ts latest|down
import { db } from './index.js';
import { assertMigrationsOk, createMigrator } from './migrator.js';

const direction = process.argv[2] ?? 'latest';
const migrator = createMigrator(db);

try {
  const result =
    direction === 'down' ? await migrator.migrateDown() : await migrator.migrateToLatest();
  for (const r of result.results ?? []) {
    console.log(`${r.status.padEnd(8)} ${r.direction.padEnd(4)} ${r.migrationName}`);
  }
  if (!result.results?.length) console.log('Nothing to migrate.');
  assertMigrationsOk(result);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
