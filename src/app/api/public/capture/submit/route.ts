// Submissão pública de um formulário de captação. Resolve o form pelo slug,
// valida (honeypot + obrigatórios), e joga o lead no funil da conta via ingestLead
// (contato + card + tarefa + rodízio). Sob /api/public (liberado no middleware).
import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'

import { db, captureForms, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { ingestLead } from '@/lib/leads/ingest'
import { getPublicCaptureForm } from '@/lib/capture/public'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
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

    await ingestLead(form.accountId, auditUser, {
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

    await db
      .update(captureForms)
      .set({ submissions: sql`submissions + 1` })
      .where(eq(captureForms.id, form.id))

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[capture submit]', err)
    return NextResponse.json({ ok: false, error: 'Falha ao enviar.' }, { status: 500 })
  }
}
