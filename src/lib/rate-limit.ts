import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Result } from 'ioredis';
import { redis } from './redis.js';
import { AppError } from './errors.js';

/**
 * Token bucket in Redis. Every API instance shares one bucket per key, so limits hold no
 * matter which server a request lands on (an in-memory limiter would give each of N
 * instances its own allowance, letting clients get N times the limit).
 *
 * The bucket holds up to `capacity` tokens and refills continuously at `refillPerSec`.
 * Each request takes one. Bursts up to `capacity` are allowed, and the sustained rate is
 * `refillPerSec`.
 *
 * The whole read-modify-write runs as one Lua script, which Redis executes atomically, so
 * concurrent requests can't both spend the last token. The script reads the Redis
 * server's clock rather than the app servers' clocks, which may disagree.
 */
const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * per_ms)

local allowed = 0
local retry_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_ms = math.ceil((1 - tokens) / per_ms)
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / per_ms) + 1000)
return { allowed, math.floor(tokens), retry_ms }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    tokenBucket(key: string, capacity: number, perMs: number): Result<[number, number, number], Context>;
  }
}
redis.defineCommand('tokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET });

export interface RateLimitRule {
  /** Namespace for the key, e.g. "login:ip". */
  name: string;
  capacity: number;
  refillPerSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export async function consume(rule: RateLimitRule, id: string): Promise<RateLimitResult> {
  try {
    const [allowed, remaining, retryAfterMs] = await redis.tokenBucket(
      `rl:${rule.name}:${id}`,
      rule.capacity,
      rule.refillPerSec / 1000,
    );
    return { allowed: allowed === 1, remaining, retryAfterMs };
  } catch {
    // Fail open: if Redis is unreachable, serving traffic without rate limits beats
    // refusing every request. The outage itself is reported by /health and the logs.
    return { allowed: true, remaining: rule.capacity, retryAfterMs: 0 };
  }
}

/**
 * Consume from each rule (all must allow) and set RateLimit headers from the tightest one.
 * Throws 429 with Retry-After when any bucket is empty.
 */
export async function enforce(
  req: FastifyRequest,
  reply: FastifyReply,
  checks: Array<[RateLimitRule, string]>,
): Promise<void> {
  const results = await Promise.all(checks.map(([rule, id]) => consume(rule, id)));

  let tightest = 0;
  results.forEach((r, i) => {
    if (r.remaining < results[tightest]!.remaining) tightest = i;
  });
  const [rule] = checks[tightest]!;
  reply.header('ratelimit-limit', rule.capacity);
  reply.header('ratelimit-remaining', results[tightest]!.remaining);

  const blocked = results.filter((r) => !r.allowed);
  if (blocked.length) {
    const retryAfterSec = Math.ceil(Math.max(...blocked.map((r) => r.retryAfterMs)) / 1000);
    reply.header('retry-after', retryAfterSec);
    req.log.warn(
      { rules: checks.filter((_, i) => !results[i]!.allowed).map(([r]) => r.name) },
      'rate limited',
    );
    throw new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down', { retryAfterSec });
  }
}
