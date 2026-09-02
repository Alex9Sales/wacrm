// Submissão pública de um formulário de captação. Resolve o form pelo slug,
// valida (honeypot + obrigatórios), e joga o lead no funil da conta via ingestLead
// (contato + card + tarefa + rodízio). Sob /api/public (liberado no middleware).
import { NextResponse, after } from 'next/server'
import { checkRateLimit, clientIp, rateLimitResponse } from '@/lib/rate-limit';
import { eq, sql } from 'drizzle-orm'

import { db, captureForms, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { ingestLead } from '@/lib/leads/ingest'
import { getPublicCaptureForm } from '@/lib/capture/public'
import { sendCaptureAiIntro } from '@/lib/capture/ai-intro'
import { enrollContactInCadence } from '@/lib/cadences/cadence'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // 🛡️ Rate limit por IP (rota pública, auditoria 02/09).
  const rl = await checkRateLimit(`public:capture-submit:${clientIp(req)}`, { limit: 20, windowMs: 60_000 });
  if (!rl.success) return rateLimitResponse(rl);

  try {
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body) return NextResponse.json({ ok: false }, { status: 400 })

    // Honeypot: bot preencheu o campo escondido → finge sucesso, não cria nada.
    if (typeof body.site === 'string' && body.site.trim()) {
      return NextResponse.json({ ok: true })
    }

    const slug = body.slug
    if (typeof slug !== 'string') {
      return NextResponse.json({ ok: false, error: 'Formulário inválido.' }, { status: 400 })
    }
    const form = await getPublicCaptureForm(slug)
    if (!form) {
      return NextResponse.json(
        { ok: false, error: 'Formulário indisponível.' },
        { status: 404 },
      )
    }

    const val = (k: string) =>
      typeof body[k] === 'string' ? (body[k] as string).trim() : ''
    const phone = val('telefone')
    if (!phone) {
      return NextResponse.json(
        { ok: false, error: 'Informe seu WhatsApp.' },
        { status: 400 },
      )
    }
    // WhatsApp COM DDD (com ou sem +55) — sem DDD o número é inútil e a IA
    // não consegue chamar de volta.
    const telDigits = phone.replace(/\D/g, '')
    const national = telDigits.startsWith('55') ? telDigits.slice(2) : telDigits
    if (national.length < 10 || national.length > 11) {
      return NextResponse.json(
        { ok: false, error: 'Informe o WhatsApp com DDD — ex.: (67) 99999-9999' },
        { status: 400 },
      )
    }
    for (const f of form.fields) {
      if (f.required && !val(f.key)) {
        return NextResponse.json(
          { ok: false, error: `Preencha: ${f.label}` },
          { status: 400 },
        )
      }
    }

    const nome = val('nome')
    const email = val('email')
    const empresa = val('empresa')
    const mensagem = val('mensagem')
    const notes = mensagem
      ? `Mensagem do formulário "${form.name}":\n${mensagem}`
      : null

    // Usuário de auditoria pro ingestLead: o criador do form; senão, um membro.
    let auditUser = form.createdBy
    if (!auditUser) {
      const m = firstOrNull(
        await db
          .select({ userId: member.userId })
          .from(member)
          .where(eq(member.organizationId, form.accountId))
          .limit(1),
      )
      auditUser = m?.userId ?? null
    }
    if (!auditUser) {
      return NextResponse.json(
        { ok: false, error: 'Conta sem responsável configurado.' },
        { status: 500 },
      )
    }

    const lead = await ingestLead(form.accountId, auditUser, {
      rawPhone: phone,
      name: nome || null,
      email: email || null,
      company: empresa || null,
      notes,
      pipelineId: form.pipelineId,
      stageId: form.stageId,
      origin: form.origin || 'Formulário',
      source: `Formulário: ${form.name}`,
    })

    // Obrigado que Vende: cadência automática pra quem envia (best-effort,
    // fora do request; pausa sozinha quando o lead responder).
    if (form.cadenceId && lead.contactId) {
      const cadenceId = form.cadenceId
      after(async () => {
        try {
          await enrollContactInCadence(
            { accountId: form.accountId, userId: auditUser },
            { cadenceId, contactId: lead.contactId, dealId: lead.dealId },
          )
        } catch (err) {
          console.error('[capture submit] cadência falhou:', err)
        }
      })
    }

    await db
      .update(captureForms)
      .set({ submissions: sql`submissions + 1` })
      .where(eq(captureForms.id, form.id))

    // IA no Segundo Zero: primeira mensagem no WhatsApp segundos após o envio.
    // Fora do request (after) pra resposta do form continuar instantânea;
    // best-effort — o lead JÁ está garantido no funil.
    if (form.aiIntro) {
      after(() =>
        sendCaptureAiIntro({
          accountId: form.accountId,
          formName: form.name,
          channelId: form.introChannelId,
          phone,
          name: nome || null,
          company: empresa || null,
          email: email || null,
          message: mensagem || null,
        }),
      )
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[capture submit]', err)
    return NextResponse.json({ ok: false, error: 'Falha ao enviar.' }, { status: 500 })
  }
}
