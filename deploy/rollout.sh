#!/usr/bin/env bash
# Replace the API replicas with a new release without dropping a request.
#
#   deploy/rollout.sh
#
# `docker compose up -d` recreates every replica at once, so for several seconds Nginx has
# nothing to send requests to. This script replaces them in an order that always leaves a
# healthy replica for every request:
#
#   1. start as many new replicas as are running, next to the old ones, and wait until each
#      passes its health check (GET /health/ready);
#   2. pin Nginx to the new replicas' addresses and reload it. A reload is graceful: old Nginx
#      workers finish their in-flight requests, new workers only use the new replicas;
#   3. stop the old replicas. SIGTERM makes each finish its in-flight requests and close its
#      WebSockets with "going away", so browsers reconnect, to a new replica;
#   4. point Nginx back at the service name, which now resolves to the new replicas only.
#
# Why not simply stop the old replicas and let Nginx's DNS re-resolution catch up? For up to
# 2 s after a container exits, Nginx still sends requests to its IP address, which nothing
# answers any more. Such a request waits out the connect timeout, and by then the replica list
# has changed, which stops Nginx from retrying it on another replica: the client gets a 502.
#
# If a new replica doesn't become healthy, the new replicas are removed and Nginx is never
# touched: a bad release fails the deploy without taking the site down.
#
# COMPOSE is the compose command, including any -f/--env-file flags (default: docker compose).
# TIMEOUT is how long to wait for the new replicas to become healthy, in seconds.
set -euo pipefail

TIMEOUT=${TIMEOUT:-180}
read -r -a COMPOSE <<<"${COMPOSE:-docker compose}"

running() { "${COMPOSE[@]}" ps --quiet api | sort; }
health() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1"; }
address() { docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
# Set the api upstream's servers (no arguments: the service name), check the config, reload.
upstream() {
  "${COMPOSE[@]}" exec -T nginx sh -c \
    '/docker-entrypoint.d/15-api-upstream.sh "$@" && nginx -t -q && nginx -s reload' sh "$@"
}

old=$(running)
if [[ -z $old ]]; then
  echo "rollout: no running api replicas, starting them normally"
  exec "${COMPOSE[@]}" up -d api
fi
count=$(wc -l <<<"$old" | tr -d ' ')

echo "rollout: starting $count new api replicas next to the $count running ones"
"${COMPOSE[@]}" up -d --no-deps --no-recreate --scale "api=$((count * 2))" api
new=$(comm -13 <(echo "$old") <(running))

deadline=$((SECONDS + TIMEOUT))
for id in $new; do
  until [[ $(health "$id") =~ ^(healthy|running)$ ]]; do
    status=$(health "$id")
    if [[ $status =~ ^(unhealthy|exited|dead)$ ]] || ((SECONDS >= deadline)); then
      echo "rollout: new replica ${id:0:12} is $status; removing the new replicas, old ones keep serving" >&2
      docker logs --tail 30 "$id" >&2 || true
      # shellcheck disable=SC2086 # one argument per container id
      docker rm -f $new >/dev/null
      exit 1
    fi
    sleep 2
  done
  echo "rollout: ${id:0:12} is healthy"
done

addresses=()
for id in $new; do addresses+=("$(address "$id")"); done
echo "rollout: pointing Nginx at the new replicas (${addresses[*]})"
trap 'echo "rollout: restoring the Nginx upstream" >&2; upstream' EXIT
upstream "${addresses[@]}"
sleep 1 # let old Nginx workers hand their last requests to the old replicas

echo "rollout: stopping the old replicas"
# shellcheck disable=SC2086
docker stop --time 30 $old >/dev/null
# shellcheck disable=SC2086
docker rm $old >/dev/null

trap - EXIT
upstream
echo "rollout: done, $count new api replicas serving"
