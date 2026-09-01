// ============================================================
// Sync ERP → CRM (compras) — tick horário; roda 1x/dia por conta (05h no fuso
// da conta) pra toda conta que tem a ferramenta `historico_compras` ligada.
//
// Por quê (01/09, caso Poleana): venda feita FORA do CRM (fone/ERP direto)
// não vira customer_transaction, então "Chamar de volta" e a memória
// comercial ficam desatualizados — a Poleana comprou 31/08 e apareceu como
// "recompra atrasada" no dia seguinte. A IA já consulta o ERP pela mesma
// ferramenta; aqui a gente usa a MESMA ferramenta (com as credenciais dela)
// pra puxar as últimas compras de cada contato e gravar no CDL.
//
// Travas: 1 execução/dia/conta · sequencial com pausa (não derruba o ERP do
// cliente) · sem log em agent_tool_runs (log:false) · upsert idempotente
// por sale_id · só compras não canceladas · recompute de métricas e sinais
// no fim. Best-effort: um contato que falha não derruba a rodada.
// ============================================================

import { Queue, Worker } from 'bullmq';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { db, agentTools, contacts, customerTransactions } from '@/db';
import { bullConnection } from '@/lib/queue/connection';
import { listEnabledTools, executeTool } from '@/lib/ai/external-tools';
import { getAccountSettings } from '@/lib/settings/account-settings';
import { recomputeMetricsForContacts } from '@/lib/cdl/metrics';
import { recomputeSignalsForAccount } from '@/lib/cdl/signals';

const QUEUE = 'erp-sync';
const TICK_MS = 60 * 60_000; // 1h
const RUN_AT_LOCAL_HOUR = 5;
const TOOL_SLUG = 'historico_compras';
const MAX_CONTACTS = 4000;
const PAUSE_MS = 120;

/** Última rodada por conta (ymd local) — evita rodar 2x no mesmo dia. */
const lastRun = new Map<string, string>();

function localHourYmd(tz: string): { hour: number; ymd: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    let hour = parseInt(get('hour'), 10);
    if (hour === 24) hour = 0;
    return { hour: Number.isFinite(hour) ? hour : 12, ymd: `${get('year')}-${get('month')}-${get('day')}` };
  } catch {
    return { hour: 12, ymd: '' };
  }
}

interface ErpPurchase {
  sale_id?: string;
  sale_date?: string;
  total?: number | string;
  status?: string;
  payment_method?: string | null;
  products?: string;
  sale_channel?: string;
}

function parsePurchases(summary: string): ErpPurchase[] {
  try {
    const j = JSON.parse(summary) as { found?: boolean; last_purchases?: ErpPurchase[] };
    if (!j || j.found === false) return [];
    return Array.isArray(j.last_purchases) ? j.last_purchases : [];
  } catch {
    return [];
  }
}

const CANCELED = /cancel/i;

export async function runErpSyncForAccount(accountId: string, agentId: string): Promise<{
  contacts: number;
  created: number;
  updated: number;
}> {
  const res = { contacts: 0, created: 0, updated: 0 };
  const tools = await listEnabledTools(accountId, agentId);
  const tool = tools.find((t) => t.slug === TOOL_SLUG);
  if (!tool) return res;

  const rows = await db
    .select({ id: contacts.id, phone: contacts.phoneNormalized })
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, accountId),
        eq(contacts.isGroup, false),
        isNotNull(contacts.phoneNormalized),
      ),
    )
    .limit(MAX_CONTACTS);

  const touched: string[] = [];
  for (const c of rows) {
    const digits = (c.phone ?? '').replace(/\D/g, '');
    if (digits.length < 10) continue;
    // A view do ERP casa por SUFIXO (like.*{telefone}) e a Maria consulta
    // "sem o 55" — mesma convenção aqui.
    const telefone = digits.replace(/^55/, '');
    res.contacts += 1;
    try {
      const r = await executeTool(
        tool,
        { telefone },
        { accountId, agentId, conversationId: null },
        { log: false },
      );
      if (r.status !== 'ok') continue;
      const purchases = parsePurchases(r.summary);
      let any = false;
      for (const p of purchases) {
        if (!p.sale_id || !p.sale_date) continue;
        if (p.status && CANCELED.test(p.status)) continue;
        const amount = Number(p.total ?? 0);
        if (!Number.isFinite(amount)) continue;
        const ins = await db
          .insert(customerTransactions)
          .values({
            accountId,
            contactId: c.id,
            type: 'purchase',
            source: 'erp',
            externalId: p.sale_id,
            occurredAt: new Date(p.sale_date).toISOString(),
            amount: String(amount),
            currency: 'BRL',
            paymentMethod: p.payment_method ?? null,
            status: 'completed',
            metadata: {
              ...(p.products ? { product: p.products } : {}),
              ...(p.sale_channel ? { sale_channel: p.sale_channel } : {}),
            },
          })
          .onConflictDoUpdate({
            target: [
              customerTransactions.accountId,
              customerTransactions.source,
              customerTransactions.externalId,
            ],
            targetWhere: sql`external_id IS NOT NULL`,
            set: {
              amount: String(amount),
              paymentMethod: p.payment_method ?? null,
              occurredAt: new Date(p.sale_date).toISOString(),
              updatedAt: sql`now()`,
            },
          })
          .returning({ inserted: sql<boolean>`(xmax = 0)` });
        if (ins[0]?.inserted) res.created += 1;
        else res.updated += 1;
        any = true;
      }
      if (any) touched.push(c.id);
    } catch (err) {
      console.error('[erp-sync] contato falhou:', c.id, err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }

  if (touched.length > 0) {
    try {
      await recomputeMetricsForContacts(accountId, touched);
    } catch (err) {
      console.error('[erp-sync] recompute métricas falhou:', err);
    }
    try {
      await recomputeSignalsForAccount(accountId);
    } catch (err) {
      console.error('[erp-sync] recompute sinais falhou:', err);
    }
  }
  return res;
}

async function tick(): Promise<void> {
  const accounts = await db
    .selectDistinct({ accountId: agentTools.accountId, agentId: agentTools.agentId })
    .from(agentTools)
    .where(and(eq(agentTools.slug, TOOL_SLUG), eq(agentTools.enabled, true)));
  for (const a of accounts) {
    if (!a.agentId) continue;
    let tz = 'America/Sao_Paulo';
    try {
      tz = (await getAccountSettings(a.accountId)).businessTimezone || tz;
    } catch {
      /* fail-open */
    }
    const { hour, ymd } = localHourYmd(tz);
    if (hour !== RUN_AT_LOCAL_HOUR || !ymd) continue;
    if (lastRun.get(a.accountId) === ymd) continue;
    lastRun.set(a.accountId, ymd);
    const started = Date.now();
    try {
      const r = await runErpSyncForAccount(a.accountId, a.agentId);
      console.log(
        `[erp-sync] ${a.accountId.slice(0, 8)}: ${r.contacts} contatos · ${r.created} novas · ${r.updated} atualizadas · ${Math.round((Date.now() - started) / 1000)}s`,
      );
    } catch (err) {
      console.error('[erp-sync] rodada falhou:', a.accountId, err);
    }
  }
}

export function startErpSyncWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('erp-sync-tick', {}, { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[erp-sync] schedule failed:', err);
    }
  })();
  const worker = new Worker(QUEUE, async () => tick(), { connection: bullConnection(), concurrency: 1 });
  worker.on('failed', (_job, err) => console.error('[erp-sync] tick failed:', err));
  console.log(`[erp-sync] started — tick every ${TICK_MS / 60000}min, roda às ${RUN_AT_LOCAL_HOUR}h locais`);
  return worker;
}
