// ============================================================
// 🎂 Parabéns automático — tick de 15 min. Pra cada conta com
// settings.birthdayGreeting.enabled, na hora local configurada, manda a
// mensagem (com {{nome}}) pra todo contato que faz aniversário HOJE e ainda
// não recebeu este ano. Pedido do Rafael (01/09): "automação de aniversário
// pré-feita, o cliente edita e liga".
//
// Travas: OFF por padrão · 1 parabéns por contato por ano
// (contacts.last_birthday_greeting_at) · pula grupo, opt-out e sem telefone
// · teto de 150 por conta por tick, espaçados (não é disparo em massa) ·
// canal = o da última conversa do contato, senão o canal padrão da conta ·
// best-effort: uma falha não derruba o tick.
// ============================================================

import { Queue, Worker } from 'bullmq';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';

import { db, contacts, conversations } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { bullConnection } from '@/lib/queue/connection';
import { getAccountSettings } from '@/lib/settings/account-settings';
import { accountSettings as accountSettingsTable } from '@/db';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

const QUEUE = 'birthday-greeting';
const TICK_MS = 15 * 60_000;
const MAX_PER_TICK = 150;
const PAUSE_MS = 1_500;

function localParts(tz: string): { hour: number; ymd: string; month: number; day: number } {
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
    return {
      hour: Number.isFinite(hour) ? hour : -1,
      ymd: `${get('year')}-${get('month')}-${get('day')}`,
      month: parseInt(get('month'), 10),
      day: parseInt(get('day'), 10),
    };
  } catch {
    return { hour: -1, ymd: '', month: 0, day: 0 };
  }
}

function firstName(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] || '';
}

function render(template: string, name: string | null): string {
  const first = firstName(name);
  return template
    .replace(/\{\{\s*nome\s*\}\}/gi, first)
    // "{{nome}}!" sem nome vira " !" — limpa a sobra.
    .replace(/,\s*!/g, '!')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function runBirthdayGreetingsForAccount(accountId: string): Promise<number> {
  const settings = await getAccountSettings(accountId);
  const cfg = settings.birthdayGreeting;
  if (!cfg?.enabled || !cfg.message?.trim()) return 0;
  const tz = settings.businessTimezone || 'America/Sao_Paulo';
  const { hour, ymd, month, day } = localParts(tz);
  if (!ymd || hour < cfg.hour || hour >= 22) return 0; // só depois da hora configurada, nunca de madrugada/noite

  // Aniversariantes de hoje (mês/dia) que ainda não receberam HOJE (o
  // carimbo é comparado no fuso da conta — 1 por ano na prática).
  const rows = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      phone: contacts.phone,
      lastAt: contacts.lastBirthdayGreetingAt,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.accountId, accountId),
        eq(contacts.isGroup, false),
        eq(contacts.optedOut, false),
        isNotNull(contacts.birthday),
        sql`extract(month from ${contacts.birthday}) = ${month}`,
        sql`extract(day from ${contacts.birthday}) = ${day}`,
        sql`(${contacts.lastBirthdayGreetingAt} IS NULL OR (${contacts.lastBirthdayGreetingAt} AT TIME ZONE ${tz})::date < ${ymd}::date)`,
      ),
    )
    .limit(MAX_PER_TICK);

  let sent = 0;
  for (const c of rows) {
    if (!c.phone) continue;
    try {
      // Canal: o da última conversa do contato (é onde ele fala com a empresa).
      const last = firstOrNull(
        await db
          .select({ channelId: conversations.channelId })
          .from(conversations)
          .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, c.id)))
          .orderBy(desc(conversations.lastMessageAt))
          .limit(1),
      );
      const resolved = await resolveConversationByPhone(accountId, c.phone, c.name, last?.channelId ?? null);
      await sendMessageToConversation(accountId, {
        conversationId: resolved.conversationId,
        messageType: 'text',
        contentText: render(cfg.message, c.name),
      });
      await db
        .update(contacts)
        .set({ lastBirthdayGreetingAt: new Date().toISOString() })
        .where(eq(contacts.id, c.id));
      sent += 1;
    } catch (err) {
      console.error('[birthday] envio falhou:', c.id, err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  return sent;
}

async function tick(): Promise<void> {
  // Só contas que LIGARAM o recurso (jsonb) — barato mesmo com muitas contas.
  const rows = await db
    .select({ accountId: accountSettingsTable.accountId })
    .from(accountSettingsTable)
    .where(sql`(${accountSettingsTable.settings}->'birthdayGreeting'->>'enabled')::boolean = true`);
  for (const r of rows) {
    try {
      const n = await runBirthdayGreetingsForAccount(r.accountId);
      if (n > 0) console.log(`[birthday] ${r.accountId.slice(0, 8)}: ${n} parabéns enviado(s)`);
    } catch (err) {
      console.error('[birthday] conta falhou:', r.accountId, err);
    }
  }
}

export function startBirthdayWorker(): Worker {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  void (async () => {
    try {
      for (const r of await queue.getRepeatableJobs()) await queue.removeRepeatableByKey(r.key);
      await queue.add('birthday-tick', {}, { repeat: { every: TICK_MS }, removeOnComplete: true, removeOnFail: 20 });
    } catch (err) {
      console.error('[birthday] schedule failed:', err);
    }
  })();
  const worker = new Worker(QUEUE, async () => tick(), { connection: bullConnection(), concurrency: 1 });
  worker.on('failed', (_job, err) => console.error('[birthday] tick failed:', err));
  console.log(`[birthday] started — tick every ${TICK_MS / 60000}min`);
  return worker;
}
