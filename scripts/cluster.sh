#!/usr/bin/env bash
# Three API instances + one worker behind Nginx, on this machine (no Docker needed):
#
#   scripts/cluster.sh start      # http://localhost:8080 (Nginx) → :3001 :3002 :3003
#   scripts/cluster.sh loadtest   # same, with the per-IP limit raised (all k6 traffic comes from one IP)
#   scripts/cluster.sh stop|status
#
# Every instance is stateless: sessions, rate limits, seat holds, caches and live-update
# fan-out all live in Postgres and Redis. Any instance can serve any request, and killing
# one loses nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/.dev"
PORTS=(3001 3002 3003)

is_running() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

start() {
  mkdir -p "$DEV/logs" "$DEV/nginx/logs"
  cd "$ROOT"
  for i in "${!PORTS[@]}"; do
    local port=${PORTS[$i]} n=$((i + 1))
    if is_running "$DEV/api-$n.pid"; then echo "api-$n already running"; continue; fi
    # node --import tsx: one process per instance, so the pid file points at the real server.
    env PORT="$port" INSTANCE_ID="api-$n" TRUST_PROXY=loopback APP_URL=http://localhost:8080 \
      DB_POOL_MAX=20 LOG_LEVEL=warn \
      nohup node --import tsx src/server.ts >"$DEV/logs/api-$n.log" 2>&1 &
    echo $! >"$DEV/api-$n.pid"
    echo "api-$n started on :$port"
  done

  if is_running "$DEV/worker.pid"; then echo "worker already running"; else
    env APP_URL=http://localhost:8080 LOG_LEVEL=warn nohup node --import tsx src/worker.ts >"$DEV/logs/worker.log" 2>&1 &
    echo $! >"$DEV/worker.pid"
    echo "worker started"
  fi

  if [[ -f "$DEV/nginx/nginx.pid" ]] && kill -0 "$(cat "$DEV/nginx/nginx.pid")" 2>/dev/null; then echo "nginx already running"; else
    nginx -p "$DEV/nginx/" -c "$ROOT/deploy/nginx/local.conf"
    echo "nginx started on :8080"
  fi

  for _ in $(seq 1 60); do
    curl -sf localhost:8080/health >/dev/null && { echo "cluster ready: http://localhost:8080"; return; }
    sleep 0.5
  done
  echo "cluster did not become healthy; see $DEV/logs/" >&2
  exit 1
}

stop() {
  if [[ -f "$DEV/nginx/nginx.pid" ]]; then nginx -p "$DEV/nginx/" -c "$ROOT/deploy/nginx/local.conf" -s quit 2>/dev/null || true; fi
  local pids=()
  for f in "$DEV"/api-*.pid "$DEV/worker.pid"; do
    [[ -f "$f" ]] || continue
    pids+=("$(cat "$f")")
    kill "$(cat "$f")" 2>/dev/null || true # SIGTERM: graceful shutdown (finish in-flight work)
    rm -f "$f"
  done
  # Wait for them to exit, so their ports are free for the next start; force after 15 s.
  for _ in $(seq 1 30); do
    local alive=0
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [[ $alive == 0 ]] && break
    sleep 0.5
  done
  for pid in "${pids[@]}"; do kill -9 "$pid" 2>/dev/null && echo "force-killed $pid"; done
  echo "cluster stopped"
}

status() {
  for f in "$DEV"/api-*.pid "$DEV/worker.pid" "$DEV/nginx/nginx.pid"; do
    [[ -f "$f" ]] || continue
    if kill -0 "$(cat "$f")" 2>/dev/null; then echo "$(basename "$f" .pid): running"; else echo "$(basename "$f" .pid): dead"; fi
  done
}

case "${1:-status}" in
  start) start ;;
  loadtest)
    # All k6 traffic comes from this one machine, so the per-IP limit would throttle the
    # test itself. (Real buyers have distinct IPs; the per-user hold limit still applies.)
    export RATE_LIMIT_IP_CAPACITY=1000000 RATE_LIMIT_IP_REFILL_PER_SEC=1000000
    start
    ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|loadtest|stop|status" >&2; exit 1 ;;
esac
