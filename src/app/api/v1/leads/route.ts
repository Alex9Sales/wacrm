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
// The heavy lifting lives in `ingestLead` (src/lib/leads/ingest.ts) — the SAME
// core the TikTok/Meta Lead Ads webhooks use — so a form lead, an ad lead and a
// hand-typed lead all behave identically. This route just owns the HTTP shell:
// Bearer auth, CORS, and turning the rich campaign fields into notes + tags.
//
// Auth: `Authorization: Bearer <api_key>` with scope `contacts:write`. Mint a
// key with ONLY that scope for public forms — even if it leaks in page source
// the blast radius is "can create leads", nothing readable/destructive.
//
// CORS is open (*) so a browser form can POST directly.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { ingestLead, LeadPhoneError } from '@/lib/leads/ingest';

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

    const rawPhone = pick(body, ['telefone', 'phone', 'whatsapp', 'celular']);
    if (!rawPhone) {
      return json(
        { ok: false, error: 'invalid_phone', message: "'telefone' é obrigatório" },
        400,
      );
    }

    const auditUserId = await resolveAuditUserId(ctx.accountId);

    // Optional intro WhatsApp: only when the form opts in and gives the text.
    const wantsWhatsapp =
      body.send_whatsapp === true || body.send_whatsapp === 'true';
    const introText = wantsWhatsapp
      ? pick(body, ['whatsapp_text', 'intro_text']) ?? null
      : null;

    try {
      const result = await ingestLead(ctx.accountId, auditUserId, {
        rawPhone,
        name: pick(body, ['nome', 'name', 'full_name']) ?? null,
        email: pick(body, ['email', 'e-mail']) ?? null,
        company: pick(body, ['empresa', 'company']) ?? null,
        notes: buildNotes(body) || null,
        tags: detectTags(body),
        pipelineId:
          typeof body.pipeline_id === 'string' ? body.pipeline_id : null,
        stageId: typeof body.stage_id === 'string' ? body.stage_id : null,
        taskSuffix: 'lead de formulário',
        fallbackNote: 'Lead de formulário.',
        introText,
        channelId: typeof body.channel_id === 'string' ? body.channel_id : null,
        // Origem estruturada: o formulário do site cai como "Site" por padrão;
        // outras integrações mandam `origem`/`fonte` pra sobrepor.
        origin: pick(body, ['origem', 'origin']) ?? 'Site',
        source: pick(body, ['fonte', 'source', 'utm_source']) ?? null,
      });

      return json(
        {
          ok: true,
          contact_id: result.contactId,
          contact_created: result.contactCreated,
          deal_id: result.dealId,
          task_id: result.taskId,
          tags_applied: result.tagsApplied,
          whatsapp_sent: result.whatsappSent,
        },
        201,
      );
    } catch (err) {
      if (err instanceof LeadPhoneError) {
        return json({ ok: false, error: 'invalid_phone', message: err.message }, 400);
      }
      throw err;
    }
  } catch (err) {
    // Auth / scope errors come back as the standard envelope — wrap with CORS.
    return withCors(toApiErrorResponse(err));
  }
}
