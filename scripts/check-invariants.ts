/**
 * Audit the database for business-rule violations (double-sold seats, money taken with
 * nothing delivered, ...). Exit code 1 if anything is wrong.
 *
 *   npm run check:invariants
 */
import { db } from '../src/db/index.js';
import { checkInvariants, INVARIANT_NAMES } from '../src/lib/invariants.js';

try {
  const violations = await checkInvariants(db);
  for (const name of INVARIANT_NAMES) {
    const v = violations.find((x) => x.name === name);
    console.log(
      `${v ? '✗' : '✓'} ${name}${v ? `: ${v.count} (${v.description}) e.g. ${JSON.stringify(v.sample)}` : ''}`,
    );
  }
  if (violations.length) process.exitCode = 1;
  else console.log('\nAll invariants hold.');
} finally {
  await db.destroy();
}
