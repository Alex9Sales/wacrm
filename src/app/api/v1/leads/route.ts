// ============================================================
// POST /api/v1/leads — campaign/landing-page LEAD INTAKE.
//
// One call turns a form submission into a fully-formed lead INSIDE the CRM:
//   1. find-or-create the contact (phone normalized to E.164, BR-aware);
//   2. open a deal/card in the Kanban (default pipeline+stage, or the given one);
//   3. create a follow-up task linked to the contact + deal;
//   4. apply useful tags (campaign / utm / interest);
//   5. optionally fire an intro WhatsApp on a channel + an internal-chat alert.
//
// Native on purpose — no external Cloudflare Worker / n8n to host or hand the
// API token to. Reuses the SAME internals as the rest of the app (phone
// normalization, contact dedupe advisory-lock, deal/stage resolution), so a
// form lead behaves exactly like one typed in by hand.
//
// Auth: `Authorization: Bearer <api_key>` with scope `contacts:write`. Mint a
// key with ONLY that scope for public forms — even if it leaks in page source
// the blast radius is "can create leads", nothing readable/destructive.
//
// Steps 2–5 are BEST-EFFORT: a failure there never loses the contact and never
// fails the whole request — the response reports what landed.
//
// CORS is open (*) so a browser form can POST directly.
// ============================================================

import { db, deals, tasks } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse } from '@/lib/api/v1/respond';
import { normalizeInboundPhoneBR } from '@/lib/whatsapp/phone-utils';
import {
  findOrCreateContact,
  setContactTags,
  loadTagsByContact,
  resolveAuditUserId,
} from '@/lib/api/v1/contacts';
import { firstPipelineOf, firstStageOf } from '@/lib/api/v1/deals';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/** Re-emit any Response with the CORS headers merged in (used to wrap the
 *  auth-error envelope from `requireApiKey`). */
function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** First non-empty string among a set of aliases on the body. */
function pick(
  body: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Human-readable note block from the rich campaign fields, skipping blanks. */
function buildNotes(body: Record<string, unknown>): string {
  const line = (label: string, keys: string[]) => {
    const v = pick(body, keys);
    return v ? `${label}: ${v}` : null;
  };
  return [
    line('Empresa', ['empresa', 'company']),
    line('Segmento', ['segmento', 'segment']),
    line('Cidade', ['cidade', 'city']),
    line('Dor', ['dor', 'pain']),
    line('Interesse', ['interesse', 'interest']),
    line('Mensagem', ['mensagem', 'message']),
    line('Melhor horário', ['melhor_horario', 'best_time']),
    line('Origem', ['origem', 'source']),
    line('UTM Source', ['utm_source']),
    line('UTM Medium', ['utm_medium']),
    line('UTM Campaign', ['utm_campaign']),
    line('UTM Content', ['utm_content']),
  ]
    .filter(Boolean)
    .join('\n');
}

/** Tags worth attaching so the team can filter the lead source at a glance. */
function detectTags(body: Record<string, unknown>): string[] {
  const tags = new Set<string>(['lead-formulario']);
  const utmSource = pick(body, ['utm_source']);
  if (utmSource) tags.add(`utm-${utmSource.toLowerCase()}`.slice(0, 40));
  const campaign = pick(body, ['utm_campaign']);
  if (campaign) tags.add('lead-campanha');
  const interest = `${pick(body, ['interesse', 'interest']) ?? ''} ${
    pick(body, ['dor', 'pain']) ?? ''
  }`.toLowerCase();
  if (/whats|automa/.test(interest)) tags.add('interesse-whatsapp');
  return [...tags];
}

export async function POST(request: Request): Promise<Response> {
  try {
    const ctx = await requireApiKey(request, 'contacts:write');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return json({ ok: false, error: 'bad_request', message: 'JSON body required' }, 400);
    }

    // 1) Contact — phone is the primary key. Normalize (fixes the BR
    //    "0 + operadora + DDD" form) before find-or-create validates E.164.
    const rawPhone = pick(body, ['telefone', 'phone', 'whatsapp', 'celular']);
    if (!rawPhone) {
      return json(
        { ok: false, error: 'invalid_phone', message: "'telefone' é obrigatório" },
        400,
      );
    }
    const phone = normalizeInboundPhoneBR(rawPhone);
    const name = pick(body, ['nome', 'name', 'full_name']);
    const email = pick(body, ['email', 'e-mail']);
    const company = pick(body, ['empresa', 'company']);

    const auditUserId = await resolveAuditUserId(ctx.accountId);

    let contactId: string;
    let contactCreated: boolean;
    try {
      const c = await findOrCreateContact(ctx.accountId, auditUserId, {
        phone,
        name,
        email,
        company,
      });
      contactId = c.id;
      contactCreated = c.created;
    } catch {
      return json(
        {
          ok: false,
          error: 'invalid_phone',
          message: 'Telefone inválido — não foi possível criar o contato',
        },
        400,
      );
    }

    const notes = buildNotes(body);
    const displayName = name || phone;

    // 2) Deal / Kanban card (best-effort).
    let dealId: string | null = null;
    try {
      const pipelineId =
        (typeof body.pipeline_id === 'string' && body.pipeline_id) ||
        (await firstPipelineOf(ctx.accountId));
      const stageId = pipelineId
        ? (typeof body.stage_id === 'string' && body.stage_id) ||
          (await firstStageOf(pipelineId))
        : null;
      if (pipelineId && stageId) {
        const inserted = firstOrNull(
          await db
            .insert(deals)
            .values({
              userId: auditUserId,
              accountId: ctx.accountId,
              pipelineId,
              stageId,
              contactId,
              title: `Lead — ${displayName}`,
              value: '0',
              notes: notes || 'Lead de formulário.',
            })
            .returning({ id: deals.id }),
        );
        dealId = inserted?.id ?? null;
      }
    } catch (err) {
      console.error('[api/v1/leads] deal create failed:', err);
    }

    // 3) Follow-up task (best-effort).
    let taskId: string | null = null;
    try {
      const inserted = firstOrNull(
        await db
          .insert(tasks)
          .values({
            accountId: ctx.accountId,
            title: `Falar com ${displayName} — lead de formulário`,
            description: notes || null,
            type: 'follow_up',
            status: 'open',
            contactId,
            dealId,
          })
          .returning({ id: tasks.id }),
      );
      taskId = inserted?.id ?? null;
    } catch (err) {
      console.error('[api/v1/leads] task create failed:', err);
    }

    // 4) Tags (best-effort) — union with any existing so we never wipe them.
    let tagsApplied: string[] = [];
    try {
      const wanted = detectTags(body);
      const current = contactCreated
        ? []
        : ((await loadTagsByContact([contactId])).get(contactId) ?? []).map(
            (t) => t.name,
          );
      const union = [...new Set([...current, ...wanted])];
      await setContactTags(ctx.accountId, auditUserId, contactId, union);
      tagsApplied = wanted;
    } catch (err) {
      console.error('[api/v1/leads] tag apply failed:', err);
    }

    // 5) Optional intro WhatsApp (best-effort). Only when the form opts in and
    //    a channel is given/available; failure never rolls back the lead.
    let whatsappSent = false;
    const wantsWhatsapp =
      body.send_whatsapp === true || body.send_whatsapp === 'true';
    const introText = pick(body, ['whatsapp_text', 'intro_text']);
    if (wantsWhatsapp && introText) {
      try {
        const channelId =
          typeof body.channel_id === 'string' ? body.channel_id : null;
        const resolved = await resolveConversationByPhone(
          ctx.accountId,
          phone,
          name ?? null,
          channelId,
        );
        await sendMessageToConversation(ctx.accountId, {
          conversationId: resolved.conversationId,
          messageType: 'text',
          contentText: introText,
        });
        whatsappSent = true;
      } catch (err) {
        console.error('[api/v1/leads] intro whatsapp failed:', err);
      }
    }

    return json(
      {
        ok: true,
        contact_id: contactId,
        contact_created: contactCreated,
        deal_id: dealId,
        task_id: taskId,
        tags_applied: tagsApplied,
        whatsapp_sent: whatsappSent,
      },
      201,
    );
  } catch (err) {
    // Auth / scope errors come back as the standard envelope — wrap with CORS.
    return withCors(toApiErrorResponse(err));
  }
}
