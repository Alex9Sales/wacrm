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

// Flows drip scheduler — resumes flow runs whose `delay` node has elapsed.
// Dynamic import (same env-ordering reason as above).
import('./flow-scheduler-worker')
  .then((m) => m.startFlowSchedulerWorker())
  .catch((err) => {
    console.error('[worker] flow-scheduler failed to start:', err);
  });

// Follow-up inteligente — tick de 5 min que reengaja conversas paradas.
import('./followup-worker')
  .then((m) => m.startFollowupWorker())
  .catch((err) => {
    console.error('[worker] followup failed to start:', err);
  });

// AI auto-reply — the message buffer: fires the debounced reply once the
// customer stops sending (see enqueueAiReplyDebounced in the webhook).
import('./ai-reply-worker')
  .then((m) => m.startAiReplyWorker())
  .catch((err) => {
    console.error('[worker] ai-reply failed to start:', err);
  });

// IA proativa em Negociações (v2 — Fase 3): sugere campos + próximo passo
// sozinha quando o cliente escreve (debounced; opt-in por conta).
import('./deal-suggest-worker')
  .then((m) => m.startDealSuggestWorker())
  .catch((err) => {
    console.error('[worker] deal-suggest failed to start:', err);
  });

// Modo Gmail — tick de 1 min que lê a INBOX (IMAP) dos canais Gmail e traz as
// mensagens novas pro inbox do CRM.
import('./gmail-poll-worker')
  .then((m) => m.startGmailPollWorker())
  .catch((err) => {
    console.error('[worker] gmail-poll failed to start:', err);
  });
