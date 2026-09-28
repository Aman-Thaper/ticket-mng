# 0001. Fastify, Zod and Kysely on PostgreSQL

**Status:** accepted

## Context

A ticketing backend lives or dies on concurrency and correctness: seat locking, money, expiry. The code that does this must be explicit about transactions, lock clauses and isolation levels. The brief also asks for auth and booking logic written by hand, OpenAPI docs, and one codebase with a worker process.

## Decision

- **Node 24 + TypeScript** (strict). One language from the database layer to the seat-map page.
- **Fastify 5.** Schema-first routes, fast JSON serialization from the response schema, encapsulated plugins, hooks for cross-cutting concerns (request ids, rate limits, metrics).
- **Zod 4 via `fastify-type-provider-zod`.** One schema per route gives runtime validation, static types, response serialization (only declared fields leave the server) and the OpenAPI spec behind `/docs`.
- **PostgreSQL** as the single source of truth, using its strengths directly: exclusion constraints, partial unique indexes, `CHECK`s, `FOR UPDATE SKIP LOCKED`, `SERIALIZABLE`, `LISTEN/NOTIFY`, generated `tsvector` columns.
- **Kysely**, a typed SQL query builder (not an ORM), with migrations as plain SQL. Every query is visible and typed; raw `sql` where SQL is clearer.

## Consequences

- Locking and transaction boundaries are in plain sight in the service code, which is what an interviewer (or an incident) will ask about.
- More SQL to write than with an ORM, and table types to keep in step with migrations (`src/db/types.ts`).
- The schema, not the application, enforces the critical rules, so they hold even for code paths that don't exist yet.

## Alternatives considered

- **Express:** no schemas, no typed routes, slower serialization; everything Fastify gives would be glue code.
- **NestJS:** a lot of framework (decorators, DI container) between the reader and the SQL that matters.
- **Prisma / TypeORM:** hide the SQL. Row-locking clauses and `SKIP LOCKED` are awkward or impossible, and generated queries are hard to reason about under concurrency.
- **Firebase / Supabase auth, backend-as-a-service:** excluded by the brief, and they would hide exactly the parts worth learning.
