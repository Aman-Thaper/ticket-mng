# Deploying to a VPS

One Linux server runs the whole stack with Docker Compose: Nginx (HTTPS) → 3 API replicas + 1 worker → Postgres + Redis. Object storage (Cloudflare R2, AWS S3, ...) and email (any SMTP provider) are managed services. That comfortably serves a mid-sized box office; [Scaling beyond one box](#scaling-beyond-one-box) covers what comes next.

```
Internet ──443──▶ Nginx (TLS, edge rate limit) ──▶ api ×3 ──▶ Postgres
Stripe ──webhooks──┘                              worker ──▶ Redis
                                                     └────▶ R2/S3, SMTP
```

## 1. Server (one time)

A 2 vCPU / 4 GB VPS (Hetzner, DigitalOcean, ...) with Ubuntu 24.04.

```bash
# as root: an unprivileged deploy user, key-only SSH, a firewall
adduser --disabled-password deploy && usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown -R deploy: /home/deploy/.ssh
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/; s/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Docker Engine + the Compose plugin
curl -fsSL https://get.docker.com | sh && usermod -aG docker deploy
```

Point a DNS `A` record (e.g. `tickets.example.com`) at the server.

> **Docker bypasses ufw.** A published container port gets its own iptables rules, ahead of ufw's, so `ports: ['5432:5432']` would put Postgres on the internet whatever ufw says. That's why the production compose file publishes nothing except Nginx's 80 and 443, and binds the monitoring UIs to 127.0.0.1.

## 2. Code and configuration

As `deploy`:

```bash
sudo mkdir -p /srv/ticket-mng && sudo chown deploy: /srv/ticket-mng
git clone https://github.com/<you>/ticket-mng.git /srv/ticket-mng
cd /srv/ticket-mng
cp deploy/.env.production.example .env.production
chmod 600 .env.production
$EDITOR .env.production   # generate every secret with the openssl command shown next to it
```

With `NODE_ENV=production` the app refuses to start with the fake payment gateway, the `naive` hold strategy, or any secret committed to this repository.

- **Stripe:** in the dashboard, add a webhook endpoint `https://tickets.example.com/api/v1/webhooks/stripe` for `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded` and `charge.refund.updated`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`. Subscribing to more events is harmless: every event only triggers a re-read of the payment's current state.
- **Storage:** create the bucket and make `posters/*` publicly readable (R2: a public bucket or custom domain; S3: a bucket policy). The app doesn't create buckets in production (`S3_AUTO_CREATE_BUCKET=false`): infrastructure belongs in your provider's console or IaC, not in app startup.
- **Images:** CI pushes one image per commit on `main` to `ghcr.io/<you>/ticket-mng:<sha>`. If the package is private, log the server in once with a token that has `read:packages`: `echo <token> | docker login ghcr.io -u <you> --password-stdin`.

Every command below uses these:

```bash
export IMAGE=ghcr.io/<you>/ticket-mng:<sha> DOMAIN=tickets.example.com
export COMPOSE="docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file .env.production"
```

## 3. First TLS certificate

Nginx can't start its HTTPS server without a certificate, so the first one comes from certbot's own temporary web server, while nothing else listens on port 80:

```bash
$COMPOSE run --rm -p 80:80 --entrypoint certbot certbot \
  certonly --standalone -d "$DOMAIN" -m you@example.com --agree-tos --non-interactive
```

After that, the `certbot` service renews it twice a day if it's near expiry (answering Let's Encrypt's challenge through Nginx), and Nginx reloads every 6 hours to pick up renewed certificates (`deploy/nginx/reload-certs.sh`).

## 4. Start

```bash
$COMPOSE up -d
curl https://$DOMAIN/health/ready
```

The one-shot `migrate` service applies pending migrations; the API and worker start only after it succeeds. Create the first admin by signing up and promoting that account in the database:

```bash
$COMPOSE exec postgres psql -U ticket -d ticket_mng -c "UPDATE users SET role = 'admin' WHERE email = 'you@example.com'"
```

Then log in again: the role travels inside the access token.

## 5. Deploying new versions

Run the **Deploy** workflow (Actions → Deploy → the commit SHA). It needs the repository secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` and the variable `DOMAIN`. Over SSH, it:

1. checks out that commit and pulls its image;
2. runs the migrations (`$COMPOSE run --rm migrate`) while the current release keeps serving;
3. replaces the API replicas with **`deploy/rollout.sh`**;
4. recreates the worker (jobs wait in Redis meanwhile) and anything else that changed, then checks `/health/ready`.

### Why a rollout script

`docker compose up -d` recreates every replica at once: the old ones stop before the new ones can serve, and Nginx has nowhere to send requests. `deploy/rollout.sh` does it in a safe order instead:

1. Start new replicas next to the old ones and wait until each passes its health check. If one doesn't, the new replicas are removed, the old ones never stopped serving, and the deploy fails.
2. Pin Nginx to the new replicas' addresses and reload it. Reloads are graceful: old Nginx workers finish their in-flight requests.
3. Stop the old replicas: each finishes its in-flight requests and closes its WebSockets with "going away", so browsers reconnect to a new replica.
4. Point Nginx back at the `api` service name.

Measured on the local stack with 65 requests/s of mixed GET and POST traffic (`scripts/loadtest/rollout-probe.js`):

| Method                                                | Failed requests                                              |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `docker compose up -d --force-recreate api`           | 336 of 2,927 (about 5 s of 502s)                             |
| New replicas first, then stop the old ones (DNS only) | 3 of 3,902 (hung 60 s, then 502s with a 2 s connect timeout) |
| `deploy/rollout.sh` (pinned upstream)                 | **0 of 2,927** (also 0 at 4 requests/s)                      |

The middle row is why step 2 exists. Nginx re-resolves `api` every 2 s, so for up to 2 s after an old replica exits, Nginx still sends it requests. Nothing answers at that address any more, so the connection attempt hangs until the connect timeout. By then the replica list has changed, and when that happens mid-request, Nginx won't retry the request elsewhere (`NGX_BUSY`), so it returns 502. Pinning Nginx to the new replicas _before_ stopping the old ones means no request is ever routed to an address that is about to disappear. CI runs this check on every push.

**Rolling back** is deploying an older SHA. Migrations here only ever add things (tables, nullable columns, indexes), so the previous release runs fine on the newer schema. Keep it that way: split a destructive change into "stop using the column" (release N) and "drop it" (release N+1).

**Changing Nginx's configuration** (files under `deploy/nginx/`) needs `$COMPOSE up -d --force-recreate nginx`: a second or two without a proxy, so do it in a quiet moment.

`SHUTDOWN_DRAIN_MS` makes an API replica keep serving for that long after SIGTERM while reporting not-ready. It's for load balancers that poll `/health/ready` (Kubernetes, cloud load balancers). Nginx doesn't poll, which is why this setup leaves it at 0 and uses the rollout script instead.

## 6. Operations

| Task                | How                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Logs                | `$COMPOSE logs -f api worker nginx`. Every line is JSON. The API and Nginx log the same `requestId` for a request (Nginx generates it and passes `X-Request-Id`), and the jobs a request caused log it too, so one search follows a request through the proxy, the API and the worker. Ship logs to Loki, Datadog or CloudWatch with the matching Docker logging driver.        |
| Metrics             | Each API replica (`:3000/metrics`) and the worker (`:3100/metrics`) expose Prometheus metrics inside the Docker network; Nginx refuses `/metrics` from outside, and `METRICS_TOKEN` guards it as well. `$COMPOSE --profile monitoring up -d` adds Prometheus and Grafana (dashboard included); reach Grafana through an SSH tunnel: `ssh -L 3030:localhost:3030 deploy@server`. |
| Alerts worth having | 5xx rate · p95 latency · `db_pool_connections{state="waiting"} > 0` for 5 min · `queue_jobs{queue="dead-letter"} > 0` · `outbox_unpublished{measure="oldest_seconds"} > 60` · event-loop lag p99 > 200 ms                                                                                                                                                                       |
| Backups             | A daily cron job: `$COMPOSE exec -T postgres pg_dump -U ticket -Fc ticket_mng > backup-$(date +%F).dump`, then copy it off the server (e.g. to the bucket, with a lifecycle rule). **Test restores**, e.g. monthly into a scratch database; an untested backup is a hope, not a backup.                                                                                         |
| Dead jobs           | `GET /api/v1/admin/dead-letters` (admin), then `POST …/:id/retry` or `DELETE …/:id`                                                                                                                                                                                                                                                                                             |
| Business invariants | `GET /api/v1/admin/invariants` (admin): no seat sold twice, no money kept without a ticket, ... Run it after incidents and deploys.                                                                                                                                                                                                                                             |

## Email

Confirmation links, password resets and the QR tickets all go out by email, so deliverability is part of the product: a ticket email in spam becomes a problem at the door. Email is sent through [Resend](https://resend.com)'s API ([ADR 0012](adr/0012-resend.md)).

1. **Create a Resend account.** Until you verify a domain you can already test: Resend delivers mail sent from `onboarding@resend.dev`, but only to your own account's address.
2. **Verify your domain** at resend.com/domains (a subdomain such as `mail.yourdomain.com` keeps it separate from your main domain's mail). Add the **SPF** (TXT and MX) and **DKIM** (TXT) records it shows to your DNS, then add a **DMARC** record: `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:you@yourdomain.com`. Without them, Gmail and Outlook file you under spam or reject the mail.
3. **Create an API key** with "Sending access" (not "Full access": the app only sends) at resend.com/api-keys.
4. **Configure `.env.production`:**

   ```bash
   MAIL_TRANSPORT=resend
   RESEND_API_KEY=re_...
   MAIL_FROM="Ticket MNG <tickets@yourdomain.com>"   # on the verified domain
   MAIL_REPLY_TO=support@yourdomain.com              # replies from customers go here
   ```

5. **Test with real inboxes** (Gmail and Outlook) before launch: sign up, confirm, buy a ticket, and check that the QR codes show inline. Every email carries a `category` tag (`verify-email`, `booking-confirmed`, ...), so Resend's dashboard can filter by kind; `notifications.provider_message_id` links each ticket email to its entry there.

What the app does for you:

- **No duplicate ticket emails.** Ticket, reminder and refund emails carry an idempotency key (`booking-confirmed/<booking id>`), so a job retried after a crash, or after a timeout on a send that actually succeeded, doesn't email the same tickets twice.
- **Pacing.** The email queue sends at most 2 emails a second (Resend's default API limit), across all workers; raise `MAIL_RATE_PER_SECOND` if Resend raises yours.
- **Retries only when they can help.** Rate limits and Resend outages are retried with backoff. A bad API key, an unverified domain or a used-up quota go straight to the dead-letter queue (`GET /api/v1/admin/dead-letters`) with Resend's message; fix the cause, then retry them from there. Either way no email is lost.

Any SMTP provider works too: `MAIL_TRANSPORT=smtp` and `SMTP_URL=smtps://USERNAME:PASSWORD@host:465` (URL-encode special characters: `@` becomes `%40`). You lose the idempotency keys and the precise error handling.

## Scaling beyond one box

In roughly the order you'd need them:

1. **Postgres on its own machine** (or managed: RDS, Cloud SQL, Neon), then **PgBouncer** in transaction mode so many API replicas share a few database connections. Replicas × `DB_POOL_MAX` must stay below Postgres' `max_connections`; that's the constraint to watch.
2. **More API replicas on more machines** behind a managed load balancer. No state lives in an instance (sessions, holds, rate limits, caches, idempotency keys and WebSocket fan-out all live in Postgres and Redis), so this is purely an infrastructure change. Set `SHUTDOWN_DRAIN_MS` to about twice the load balancer's health-check interval.
3. **Workers on separate machines**, scaled per queue. Several outbox relays can run at once (`FOR UPDATE SKIP LOCKED`), and fixed job ids make duplicate publishing harmless.
4. **Redis with a replica and Sentinel** (or managed). Without Redis the claim gate and caches are skipped and Postgres copes, but queues, live updates and rate limits need it.
5. **A virtual waiting room** for the biggest on-sales: admit buyers to the seat map at a controlled rate, so the hold endpoint never sees more concurrency than the database can serve.
