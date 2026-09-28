#!/bin/sh
# Writes the server list of Nginx's "api" upstream (the Nginx config includes this file).
#
# With no arguments, which is how the official image runs it at startup from
# /docker-entrypoint.d/: the compose service name. Docker's DNS resolves "api" to every
# replica, and "resolve" makes Nginx re-resolve it as replicas come and go.
#
# With IP addresses as arguments: exactly those replicas. deploy/rollout.sh pins Nginx to the
# new replicas this way while it retires the old ones, then runs this again without arguments.
set -eu
file=/etc/nginx/upstream-api.conf

if [ $# -eq 0 ]; then
  echo 'server api:3000 resolve max_fails=3 fail_timeout=5s;' >"$file.tmp"
else
  for ip in "$@"; do
    echo "server $ip:3000 max_fails=3 fail_timeout=5s;"
  done >"$file.tmp"
fi
# Atomic replace: a reload running at the same moment never reads a half-written file.
mv "$file.tmp" "$file"
