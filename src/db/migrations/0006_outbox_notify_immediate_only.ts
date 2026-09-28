import { sql, type Kysely } from 'kysely';

// Found in load testing: every seat hold writes an outbox row (its expiry job, due in 10
// minutes), and the old statement-level trigger sent a NOTIFY for each of those
// transactions. NOTIFY takes a cluster-wide lock at commit, so at high commit rates it
// serializes otherwise independent transactions, all to wake a relay for a job that
// won't run for 10 minutes. Now only jobs that are due immediately notify; delayed jobs
// are picked up by the relay's regular poll.

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER outbox_notify ON outbox;
    CREATE TRIGGER outbox_notify AFTER INSERT ON outbox
      FOR EACH ROW WHEN (NEW.run_at <= now())
      EXECUTE FUNCTION notify_outbox();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER outbox_notify ON outbox;
    CREATE TRIGGER outbox_notify AFTER INSERT ON outbox
      FOR EACH STATEMENT EXECUTE FUNCTION notify_outbox();
  `.execute(db);
}
