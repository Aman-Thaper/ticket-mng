#!/usr/bin/env bash
# Local infrastructure without Docker: Redis, Mailpit (SMTP catcher) and MinIO (S3).
# Data and logs live in .dev/ (gitignored). Postgres is expected to run separately.
#
#   scripts/dev-services.sh start|stop|status
#
# With Docker available, `docker compose up -d postgres redis minio mailpit` does the same job.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.dev"
mkdir -p "$DEV/logs" "$DEV/redis" "$DEV/minio"

is_running() { [[ -f "$DEV/$1.pid" ]] && kill -0 "$(cat "$DEV/$1.pid")" 2>/dev/null; }

start() {
  if is_running redis; then echo "redis    already running"; else
    # noeviction: BullMQ must never have its job keys evicted under memory pressure.
    redis-server --port 6379 --bind 127.0.0.1 --daemonize yes \
      --dir "$DEV/redis" --appendonly yes --maxmemory-policy noeviction \
      --pidfile "$DEV/redis.pid" --logfile "$DEV/logs/redis.log"
    echo "redis    started on :6379"
  fi

  if is_running mailpit; then echo "mailpit  already running"; else
    nohup mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025 \
      --database "$DEV/mailpit.db" >"$DEV/logs/mailpit.log" 2>&1 &
    echo $! >"$DEV/mailpit.pid"
    echo "mailpit  started: SMTP :1025, inbox UI http://localhost:8025"
  fi

  if is_running minio; then echo "minio    already running"; else
    MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
      nohup minio server "$DEV/minio" --address 127.0.0.1:9000 --console-address 127.0.0.1:9001 \
      >"$DEV/logs/minio.log" 2>&1 &
    echo $! >"$DEV/minio.pid"
    echo "minio    started: S3 :9000, console http://localhost:9001 (minioadmin/minioadmin)"
  fi
}

stop() {
  for svc in mailpit minio; do
    if is_running "$svc"; then kill "$(cat "$DEV/$svc.pid")" && echo "$svc stopped"; fi
    rm -f "$DEV/$svc.pid"
  done
  if is_running redis; then redis-cli -p 6379 shutdown >/dev/null 2>&1 || true; echo "redis stopped"; fi
}

status() {
  for svc in redis mailpit minio; do
    if is_running "$svc"; then echo "$svc: running (pid $(cat "$DEV/$svc.pid"))"; else echo "$svc: stopped"; fi
  done
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 1 ;;
esac
