// ============================================================
// 📒 Agenda do celular → CRM (09/09/2026).
//
// Pedido do Alex: "puxar os contatos pro CRM do jeito que salvei no celular"
// + "nome que editei no CRM não pode voltar pro nome do WhatsApp".
//
// Fluxo:
//   1. `refreshPhonebookFromChannel` (WAHA) puxa a agenda do aparelho pareado
//      (provider.listPhonebook) e espelha em `phonebook_entries` por canal.
//      Na API oficial em coexistência a Meta EMPURRA a agenda pelo webhook
//      smb_app_state_sync → `ingestMetaStateSync`.
//   2. `applyPhonebook` casa cada entrada com os contatos da conta pela chave
//      de identidade (DDD + 8 dígitos — o id do WhatsApp costuma vir sem o 9º
//      dígito) e aplica a regra de nome (lib/contacts/name-rule.ts). Pode
//      criar os contatos que ainda não existem (só no import manual).
//   3. O worker `phonebook-sync` repete 1+2 (modo 'fill', sem criar) a cada
//      6 h pros canais que já importaram uma vez (channels.phonebook_synced_at).
//   4. O inbound consulta `lookupPhonebookName` ao criar contato / preencher
//      nome, pra um número salvo já nascer com o nome da agenda.
//
// Worker-reachable: NADA de `import 'server-only'` aqui.
// ============================================================

import { and, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';

import { db, channels, contacts, phonebookEntries } from '@/db';
import { loadChannel } from '@/lib/channels/channels';
import type { ChannelCtx, PhonebookContact } from '@/lib/channels/provider';
import { getProvider } from '@/lib/channels/registry';
import { brIdentityKey, normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils';
import { asNameSource, decideContactName, type NameMode } from './name-rule';

/**
 * Chave de identidade de um telefone pra casar agenda × CRM: DDD + 8 dígitos
 * pra número brasileiro (tolera 55 e 9º dígito); dígitos crus pro resto.
 */
export function identityKeyOf(phone: string): string | null {
  const d = normalizePhone(phone);
  if (!d) return null;
  return brIdentityKey(d) ?? d;
}

export interface PhonebookApplySummary {
  dryRun: boolean;
  mode: NameMode;
  createMissing: boolean;
  /** Entradas da agenda consideradas (1 por pessoa). */
  entries: number;
  /** Já existem no CRM. */
  matched: number;
  /** Ainda não existem no CRM. */
  notInCrm: number;
  /** Criados agora (0 em prévia ou sem createMissing). */
  created: number;
  /** Estava sem nome / só com o telefone → ganhou o nome da agenda. */
  filled: number;
  /** Tinha o nome de perfil do WhatsApp → trocou pelo da agenda. */
  upgraded: number;
  /** Já vinha da agenda e a agenda mudou → acompanhou. */
  mirrored: number;
  /** Nome legado (origem desconhecida) trocado — só no modo 'override'. */
  overridden: number;
  /** Editado no CRM → intocável. */
  keptCrm: number;
  /** Legado mantido (modo 'fill'). */
  keptLegacy: number;
  /** Mesmo nome dos dois lados. */
  unchanged: number;
  /** Até 5 exemplos de troca (prévia). */
  examples: { from: string; to: string }[];
}

export interface ApplyPhonebookOptions {
  accountId: string;
  /** Só as entradas deste canal (null = todos os canais da conta). */
  channelId?: string | null;
  mode: NameMode;
  /** Criar no CRM quem está na agenda e ainda não existe (exige userId). */
  createMissing: boolean;
  /** Dono (user_id) dos contatos criados. */
  userId?: string | null;
  /** Só calcula — não grava nada. */
  dryRun?: boolean;
  /** Restringe a estes telefones (webhook da Meta: só o que chegou agora). */
  onlyPhones?: string[];
}

function emptySummary(o: ApplyPhonebookOptions): PhonebookApplySummary {
  return {
    dryRun: o.dryRun === true,
    mode: o.mode,
    createMissing: o.createMissing,
    entries: 0,
    matched: 0,
    notInCrm: 0,
    created: 0,
    filled: 0,
    upgraded: 0,
    mirrored: 0,
    overridden: 0,
    keptCrm: 0,
    keptLegacy: 0,
    unchanged: 0,
    examples: [],
  };
}

export interface PhonebookPlan {
  summary: PhonebookApplySummary;
  updates: { id: string; name: string }[];
  creates: { phone: string; name: string }[];
}

/**
 * PURO: casa a agenda com os contatos e decide o que muda (nada de banco).
 * `entries` já vem 1-por-pessoa e na ordem de prioridade (o 1º de cada chave
 * vence). Usado pelo apply, pela prévia e por sondas read-only.
 */
export function planPhonebook(
  entries: { phone: string; name: string | null }[],
  contactRows: { id: string; phone: string; name: string | null; nameSource: string | null }[],
  o: Pick<ApplyPhonebookOptions, 'mode' | 'createMissing' | 'onlyPhones' | 'dryRun'>,
): PhonebookPlan {
  const summary = emptySummary({ accountId: '', ...o });

  // 1) Agenda (1 entrada por pessoa; a mais recente vence quando 2 canais
  //    têm o mesmo número salvo com nomes diferentes).
  const only = o.onlyPhones
    ? new Set(o.onlyPhones.map((p) => identityKeyOf(p)).filter((k): k is string => !!k))
    : null;
  const byEntry = new Map<string, { phone: string; name: string }>();
  for (const r of entries) {
    const key = identityKeyOf(r.phone);
    if (!key || byEntry.has(key)) continue;
    if (only && !only.has(key)) continue;
    const name = (r.name ?? '').trim();
    if (!name) continue;
    byEntry.set(key, { phone: r.phone, name });
  }
  summary.entries = byEntry.size;
  const updates: { id: string; name: string }[] = [];
  const creates: { phone: string; name: string }[] = [];
  if (byEntry.size === 0) return { summary, updates, creates };

  // 2) Contatos indexados pela mesma chave.
  const byKey = new Map<string, typeof contactRows>();
  for (const c of contactRows) {
    const key = identityKeyOf(c.phone);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(c);
    else byKey.set(key, [c]);
  }

  // 3) Decide.
  for (const [key, e] of byEntry) {
    const hits = byKey.get(key);
    if (!hits || hits.length === 0) {
      summary.notInCrm += 1;
      if (o.createMissing && e.phone.replace(/\D/g, '').length >= 8) creates.push(e);
      continue;
    }
    summary.matched += 1;
    for (const c of hits) {
      const d = decideContactName({
        current: { name: c.name, phone: c.phone, source: asNameSource(c.nameSource) },
        incoming: { name: e.name, source: 'phonebook' },
        mode: o.mode,
      });
      if (d.apply) {
        if (d.reason === 'fill') summary.filled += 1;
        else if (d.reason === 'upgrade') summary.upgraded += 1;
        else if (d.reason === 'mirror') summary.mirrored += 1;
        else summary.overridden += 1;
        if (d.reason !== 'fill' && summary.examples.length < 5) {
          summary.examples.push({ from: (c.name ?? '').trim(), to: e.name });
        }
        updates.push({ id: c.id, name: e.name });
      } else if (d.reason === 'crm-wins') summary.keptCrm += 1;
      else if (d.reason === 'legacy-kept') summary.keptLegacy += 1;
      else summary.unchanged += 1;
    }
  }
  summary.created = o.dryRun ? creates.length : 0;
  return { summary, updates, creates };
}

/** Contatos da conta (sem grupos) no formato que o plano espera. */
export async function loadContactsForPlan(accountId: string) {
  return db
    .select({
      id: contacts.id,
      phone: contacts.phone,
      name: contacts.name,
      nameSource: contacts.nameSource,
    })
    .from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.isGroup, false)));
}

/**
 * Aplica a agenda espelhada (phonebook_entries) aos contatos da conta com a
 * regra de nome. Idempotente: rodar de novo sem mudança na agenda não grava.
 */
export async function applyPhonebook(o: ApplyPhonebookOptions): Promise<PhonebookApplySummary> {
  const dryRun = o.dryRun === true;
  if (o.createMissing && !dryRun && !o.userId) {
    throw new Error('applyPhonebook: createMissing exige userId');
  }

  const entryRows = await db
    .select({ phone: phonebookEntries.phone, name: phonebookEntries.name })
    .from(phonebookEntries)
    .where(
      and(
        eq(phonebookEntries.accountId, o.accountId),
        o.channelId ? eq(phonebookEntries.channelId, o.channelId) : undefined,
      ),
    )
    .orderBy(desc(phonebookEntries.seenAt));
  if (entryRows.length === 0) return emptySummary(o);

  const contactRows = await loadContactsForPlan(o.accountId);
  const { summary, updates, creates } = planPhonebook(entryRows, contactRows, o);
  if (dryRun) return summary;

  // 4) Grava — nome + origem 'phonebook', em lotes.
  const now = new Date().toISOString();
  for (let i = 0; i < updates.length; i += 50) {
    await Promise.all(
      updates.slice(i, i + 50).map((u) =>
        db
          .update(contacts)
          .set({ name: u.name, nameSource: 'phonebook', updatedAt: now })
          .where(and(eq(contacts.id, u.id), eq(contacts.accountId, o.accountId))),
      ),
    );
  }
  for (let i = 0; i < creates.length; i += 100) {
    const chunk = creates.slice(i, i + 100);
    try {
      const inserted = await db
        .insert(contacts)
        .values(
          chunk.map((e) => ({
            accountId: o.accountId,
            userId: o.userId as string,
            phone: e.phone,
            name: e.name,
            nameSource: 'phonebook' as const,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: contacts.id });
      summary.created += inserted.length;
    } catch (err) {
      console.error('[phonebook] criar contatos falhou (lote):', err instanceof Error ? err.message : err);
    }
  }
  return summary;
}

/**
 * Puxa a agenda do aparelho (provider.listPhonebook) e espelha em
 * phonebook_entries. Remove da tabela quem sumiu da agenda — só quando a
 * leitura parece completa (≥ metade do que tínhamos), pra uma leitura parcial
 * do engine não apagar o espelho.
 */
export async function refreshPhonebookFromChannel(
  ch: ChannelCtx,
): Promise<{ pulled: number; pruned: number }> {
  const provider = getProvider(ch.provider);
  if (!provider.listPhonebook) {
    throw new Error('Este canal não expõe a agenda do celular.');
  }
  const startedAt = new Date().toISOString();
  const pulled: PhonebookContact[] = await provider.listPhonebook(ch);

  const byPhone = new Map<string, PhonebookContact>();
  for (const p of pulled) {
    const phone = p.phone.replace(/\D/g, '');
    const name = (p.name ?? '').trim();
    if (!phone || !name || byPhone.has(phone)) continue;
    byPhone.set(phone, { phone, name, pushName: p.pushName ?? null });
  }
  const rows = [...byPhone.values()];

  const prev = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(phonebookEntries)
    .where(eq(phonebookEntries.channelId, ch.id));
  const prevCount = Number(prev[0]?.n ?? 0);

  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db
      .insert(phonebookEntries)
      .values(
        chunk.map((p) => ({
          accountId: ch.accountId,
          channelId: ch.id,
          phone: p.phone,
          name: p.name,
          pushName: p.pushName ?? null,
          seenAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [phonebookEntries.channelId, phonebookEntries.phone],
        set: {
          name: sql`excluded.name`,
          pushName: sql`excluded.push_name`,
          seenAt: sql`excluded.seen_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  let pruned = 0;
  if (rows.length > 0 && rows.length * 2 >= prevCount) {
    const gone = await db
      .delete(phonebookEntries)
      .where(and(eq(phonebookEntries.channelId, ch.id), lt(phonebookEntries.seenAt, startedAt)))
      .returning({ id: phonebookEntries.id });
    pruned = gone.length;
  }

  await db
    .update(channels)
    .set({ phonebookSyncedAt: now, updatedAt: now })
    .where(eq(channels.id, ch.id));

  return { pulled: rows.length, pruned };
}

/** Quantas entradas a agenda espelhada tem pra este canal + última sync. */
export async function phonebookStatus(
  channelId: string,
): Promise<{ entries: number; syncedAt: string | null }> {
  const [cnt, ch] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(phonebookEntries)
      .where(eq(phonebookEntries.channelId, channelId)),
    db
      .select({ syncedAt: channels.phonebookSyncedAt })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1),
  ]);
  return { entries: Number(cnt[0]?.n ?? 0), syncedAt: ch[0]?.syncedAt ?? null };
}

/**
 * Nome SALVO na agenda pra este telefone (qualquer canal da conta), ou null.
 * Best-effort: usado no inbound — nunca lança.
 */
export async function lookupPhonebookName(accountId: string, phone: string): Promise<string | null> {
  const normalized = normalizePhone(phone);
  if (!normalized || normalized.length < 8) return null;
  const suffix = normalized.slice(-8);
  try {
    const rows = await db
      .select({ phone: phonebookEntries.phone, name: phonebookEntries.name })
      .from(phonebookEntries)
      .where(
        and(
          eq(phonebookEntries.accountId, accountId),
          sql`right(${phonebookEntries.phone}, 8) = ${suffix}`,
        ),
      )
      .orderBy(desc(phonebookEntries.seenAt))
      .limit(10);
    const hit = rows.find((r) => phonesMatch(r.phone, normalized));
    const name = (hit?.name ?? '').trim();
    return name || null;
  } catch (err) {
    console.error('[phonebook] lookup falhou:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ------------------------------------------------------------
// API oficial em coexistência — webhook smb_app_state_sync
// ------------------------------------------------------------

export interface MetaStateSyncItem {
  type?: string;
  action?: string;
  contact?: { full_name?: string; first_name?: string; phone_number?: string };
  [key: string]: unknown;
}

/**
 * Espelha os contatos que a Meta mandou (add/remove) e aplica a regra de nome
 * SÓ nesses telefones (modo 'fill', sem criar contato — a Meta manda a agenda
 * inteira no onboarding e ninguém quer 3 mil contatos pessoais no CRM sem
 * pedir; criar fica pro botão "Importar agenda").
 */
export async function ingestMetaStateSync(
  ch: { id: string; accountId: string },
  items: MetaStateSyncItem[],
): Promise<{ added: number; removed: number; applied: PhonebookApplySummary | null }> {
  const adds: { phone: string; name: string }[] = [];
  const removes: string[] = [];
  for (const it of items) {
    if (it.type && it.type !== 'contact') continue;
    const phone = normalizePhone(it.contact?.phone_number ?? '');
    if (!phone) continue;
    if (it.action === 'remove') {
      removes.push(phone);
      continue;
    }
    const name = (it.contact?.full_name ?? it.contact?.first_name ?? '').trim();
    if (!name) continue;
    adds.push({ phone, name });
  }
  const now = new Date().toISOString();
  if (adds.length > 0) {
    for (let i = 0; i < adds.length; i += 500) {
      const chunk = adds.slice(i, i + 500);
      await db
        .insert(phonebookEntries)
        .values(
          chunk.map((a) => ({
            accountId: ch.accountId,
            channelId: ch.id,
            phone: a.phone,
            name: a.name,
            seenAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [phonebookEntries.channelId, phonebookEntries.phone],
          set: { name: sql`excluded.name`, seenAt: sql`excluded.seen_at`, updatedAt: sql`excluded.updated_at` },
        });
    }
  }
  for (const phone of removes) {
    await db
      .delete(phonebookEntries)
      .where(and(eq(phonebookEntries.channelId, ch.id), eq(phonebookEntries.phone, phone)));
  }
  await db
    .update(channels)
    .set({ phonebookSyncedAt: now, updatedAt: now })
    .where(eq(channels.id, ch.id));

  const applied =
    adds.length > 0
      ? await applyPhonebook({
          accountId: ch.accountId,
          channelId: ch.id,
          mode: 'fill',
          createMissing: false,
          onlyPhones: adds.map((a) => a.phone),
        })
      : null;
  return { added: adds.length, removed: removes.length, applied };
}

// ------------------------------------------------------------
// Worker — reconfere a agenda dos canais que já importaram
// ------------------------------------------------------------

export async function syncAllPhonebooks(): Promise<{ channels: number; failed: number }> {
  const rows = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(
      and(
        eq(channels.provider, 'waha'),
        eq(channels.status, 'connected'),
        isNotNull(channels.phonebookSyncedAt),
      ),
    );
  let failed = 0;
  for (const row of rows) {
    try {
      const ch = await loadChannel(row.id);
      if (!ch) continue;
      const r = await refreshPhonebookFromChannel(ch);
      const s = await applyPhonebook({
        accountId: ch.accountId,
        channelId: ch.id,
        mode: 'fill',
        createMissing: false,
      });
      console.log(
        `[phonebook] ${row.name}: agenda ${r.pulled} (−${r.pruned}) · preencheu ${s.filled} · trocou perfil ${s.upgraded} · acompanhou ${s.mirrored} · CRM manteve ${s.keptCrm}`,
      );
    } catch (err) {
      failed += 1;
      console.error(`[phonebook] ${row.name} falhou:`, err instanceof Error ? err.message : err);
    }
  }
  return { channels: rows.length, failed };
}
