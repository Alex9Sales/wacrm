#!/bin/sh
# One image, two roles — selected by APP_ROLE.
#   APP_ROLE=worker → BullMQ broadcast worker (npx tsx src/worker/index.ts)
#   anything else   → Next.js web server (node server.js)  [default]
set -e
if [ "$APP_ROLE" = "worker" ]; then
  echo "[entrypoint] starting WORKER role"
  exec npx tsx src/worker/index.ts
fi
echo "[entrypoint] starting WEB role"
exec node server.js
