import { hash, verify, type Algorithm } from '@node-rs/argon2';
import { config } from '../../config.js';

// Argon2id is memory-hard: every guess costs an attacker ~19 MiB of RAM as well as CPU time,
// which rules out the massively parallel GPU cracking that works against fast hashes (and
// that bcrypt only partly resists). The hash runs on libuv's thread pool, so it doesn't
// block the event loop.
const PARAMS = {
  // Algorithm is a const enum, which can't be imported as a value under isolated modules.
  algorithm: 2 as Algorithm.Argon2id,
  memoryCost: config.ARGON2_MEMORY_KIB,
  timeCost: config.ARGON2_TIME_COST,
  parallelism: 1,
};

/** Returns a self-describing PHC string: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash> */
export const hashPassword = (password: string) => hash(password, PARAMS);

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, password);
  } catch {
    return false; // malformed hash: treat as a failed login, never as a crash
  }
}

/**
 * True when a stored hash was made with different cost parameters than today's. Because the
 * parameters live inside the hash, raising them later is painless: each user's hash is
 * upgraded the next time they log in and we briefly have their plaintext password.
 */
export function needsRehash(phc: string): boolean {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
  return (
    !m ||
    Number(m[1]) !== PARAMS.memoryCost ||
    Number(m[2]) !== PARAMS.timeCost ||
    Number(m[3]) !== PARAMS.parallelism
  );
}

let dummyHash: Promise<string> | undefined;

/**
 * Spend the same time as a real verification. Used when the email doesn't exist, so the
 * response time of "unknown email" matches "wrong password" and can't be used to discover
 * which emails have accounts.
 */
export async function burnVerifyTime(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equalization-dummy-password');
  await verifyPassword(await dummyHash, password);
}
