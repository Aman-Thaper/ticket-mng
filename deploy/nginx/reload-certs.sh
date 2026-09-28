#!/bin/sh
# Mounted into /docker-entrypoint.d/, which the official Nginx image runs before starting
# Nginx. Certbot renews certificates in a shared volume, but Nginx only reads them when it
# (re)loads its configuration, so reload every 6 hours. Renewal happens 30 days before
# expiry, so a renewed certificate is always picked up long before the old one expires.
(
  while :; do
    sleep 21600
    nginx -s reload
  done
) &
