# 0010. One VPS with Docker Compose, and a rollout script for zero-downtime deploys

**Status:** accepted

## Context

The system has to run somewhere real, with HTTPS, reproducible builds, safe schema changes and deploys that don't drop an on-sale's requests. It is one team's app, not a platform.

## Decision

- **One image, built once by CI** per commit and pushed to GHCR (`ghcr.io/<you>/ticket-mng:<sha>`). The same image runs the API, the worker and the migrations. Servers pull; they never build.
- **Docker Compose on one VPS**: Nginx (TLS via Let's Encrypt, renewed by certbot), 3 API replicas, a worker, Postgres, Redis. Managed S3-compatible storage and SMTP. Only ports 80 and 443 are published, because Docker's published ports bypass ufw.
- **Secrets** in a `chmod 600` `.env.production` on the server. The app refuses to start in production with committed development secrets, the fake payment provider, or the demonstration-only locking strategy.
- **Migrations only ever add** (expand, then contract in a later release), and run before the new code starts, so the old release keeps working during a deploy and a rollback is just deploying the previous SHA.
- **Zero-downtime API deploys** with `deploy/rollout.sh`. Start new replicas next to the old ones and wait for them to be healthy. Pin Nginx to them (a graceful reload), stop the old replicas (they drain), then point Nginx back at the service name. Measured under 65 requests/s: plain `docker compose up -d` failed 336 of 2,927 requests; replacing replicas and relying on DNS failed 3; the rollout script failed 0. CI repeats that check on every push.

## Consequences

- Cheap, understandable, and everything is visible on one machine (`docker compose ps`, logs, metrics).
- The server is a single point of failure; backups (and tested restores) matter. Scaling out follows a known path: managed Postgres + PgBouncer, more API machines behind a load balancer, separate workers (see `docs/DEPLOY.md`).
- Nginx configuration changes need a container restart, a second or two of downtime.

## Alternatives considered

- **Kubernetes:** rolling updates, readiness gates and autoscaling for free, and a lot of operational weight for three replicas. The app is ready for it (`/health/live`, `/health/ready`, graceful drain with `SHUTDOWN_DRAIN_MS`, stateless replicas).
- **A PaaS** (Fly.io, Render): less to operate, less to learn from, and WebSocket plus multi-process setups vary by vendor.
- **Traefik or Caddy instead of Nginx:** both follow Docker's container events and would remove old replicas without a script. Nginx was kept because it's ubiquitous, and the script makes the mechanics explicit.
