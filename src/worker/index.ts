// ============================================================
// Worker entrypoint (`npm run worker` → tsx src/worker/index.ts).
//
// Loads .env.local FIRST, then dynamically imports the actual worker.
// The dynamic import matters: ESM hoists static `import` statements above
// all top-level code, so a static import of the worker (which transitively
// imports encryption.ts, reading ENCRYPTION_KEY at eval time) would run
// before dotenv could populate process.env. Loading env then awaiting the
// import guarantees the vars exist before any module reads them.
// ============================================================

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv(); // .env fallback (no-op if absent)

for (const required of ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY']) {
  if (!process.env[required]) {
    // eslint-disable-next-line no-console
    console.error(`[worker] ${required} is not set — add it to .env.local`);
    process.exit(1);
  }
}

// Dynamic import (not top-level await) so this works under both CJS and
// ESM tsx output — env is populated above before the worker's transitive
// imports (encryption.ts reads ENCRYPTION_KEY at eval time) run.
import('./broadcast-worker').catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[worker] failed to start:', err);
  process.exit(1);
});

// SLA auto-reassign tick. Dynamic import (same env-ordering reason as above).
import('./sla-worker')
  .then((m) => m.startSlaWorker())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[worker] sla-worker failed to start:', err);
  });

// WAHA session health monitor — detects "zombie" sessions (connected but not
// receiving) and restarts/alerts. Dynamic import (same env-ordering reason).
import('./session-monitor-worker')
  .then((m) => m.startSessionMonitor())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[worker] session-monitor failed to start:', err);
  });
