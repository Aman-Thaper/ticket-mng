// Runs once before the whole suite and brings the test database schema up to date.
export default async function setup() {
  await import('./setup-env.js');
  const { db } = await import('../src/db/index.js');
  const { createMigrator, assertMigrationsOk } = await import('../src/db/migrator.js');
  try {
    assertMigrationsOk(await createMigrator(db).migrateToLatest());
  } finally {
    await db.destroy();
  }
}
