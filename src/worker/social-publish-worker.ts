// ============================================================
// 📸 Publicação no Instagram — tick de 30s.
//   1. posts `scheduled` com scheduled_at <= agora viram `publishing`;
//   2. todo post `publishing` avança uma etapa (containers → pai → publish).
// Vídeo processa no Instagram entre ticks (o tick não bloqueia mais que ~40s
// por post). Lógica em lib/social/instagram-publish.ts (testada).
// ============================================================
import { Queue, Worker } from 'bullmq';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';

import { db, socialPosts } from '@/db';
import { bullConnection } from '@/lib/queue/connection';
import { advanceSocialPost } from '@/lib/social/instagram-publish';

const QUEUE = 'social-publish';
const TICK_MS = 30_000;
const CLAIM_PER_TICK = 5;
const ADVANCE_PER_TICK = 20;

async function claimDue(): Promise<number> {
  const due = await db
    .select({ id: socialPosts.id })
    .from(socialPosts)
    .where(and(eq(socialPosts.status, 'scheduled'), lte(socialPosts.scheduledAt, sql`now()`)))
    .orderBy(asc(socialPosts.scheduledAt))
    .limit(CLAIM_PER_TICK);
  if (due.length === 0) return 0;
  const ids = due.map((d) => d.id);
  await db
    .update(socialPosts)
    .set({
      status: 'publishing',
      publishState: { stage: 'containers', startedAt: new Date().toISOString() },
      error: null,
      updatedAt: new Date().toISOString(),
    })
    .where(and(inArray(socialPosts.id, ids), eq(socialPosts.status, 'scheduled')));
  return ids.length;
}

export async function tick(): Promise<void> {
  const claimed = await claimDue();
  if (claimed > 0) console.log(`[social] ${claimed} post(s) entraram em publicação`);
  const rows = await db
    .select({ id: socialPosts.id })
    .from(socialPosts)
    .where(eq(socialPosts.status, 'publishing'))
    .orderBy(asc(socialPosts.updatedAt))
    .limit(ADVANCE_PER_TICK);
  for (const r of rows) {
    try {
      const out = await advanceSocialPost(r.id);
      if (out === 'published') console.log(`[social] publicado ${r.id.slice(0, 8)}`);
      else if (out === 'failed') console.warn(`[social] falhou ${r.id.slice(0, 8)}`);
    } catch (err) {
      console.error('[social] advance falhou:', r.id, err instanceof Error ? err.message : err);
    }
  }
}

export function startSocialPublishWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('social-tick', {}, { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[social] schedule failed:', err);
    }
  })();
  const worker = new Worker(QUEUE, async () => tick(), { connection: bullConnection(), concurrency: 1 });
  worker.on('failed', (_job, err) => console.error('[social] tick failed:', err));
  console.log(`[social] started — tick every ${TICK_MS / 1000}s`);
  return worker;
}
