#!/bin/sh
set -e

# Runs pending migrations before the app starts, so a fresh database (or a
# schema change on redeploy) is ready before the first request comes in.
# Set SKIP_MIGRATIONS=true to disable (e.g. if you run migrations
# separately in a CI/CD step against production).
if [ "$SKIP_MIGRATIONS" != "true" ]; then
  node scripts/migrate.mjs
fi

exec "$@"
