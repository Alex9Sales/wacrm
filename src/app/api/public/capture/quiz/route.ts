// ============================================================
// Submissão pública de um QUIZ de captação (/f/[slug] com mode='quiz').
// Valida respostas contra as perguntas do form (choice tem que ser uma das
// opções — nada de texto solto indo pro prompt), joga o lead no funil via
// ingestLead (respostas viram notas do card + tarefa) e, com IA ligada, gera
// o diagnóstico NA TELA + qualificação quente/morno/frio (etiqueta no contato
// + nota no histórico do card). IA é best-effort com teto de tempo: o lead JÁ
// está garantido no funil antes de qualquer geração.
// ============================================================
import { NextResponse, after } from 'next/server'
import { eq, sql } from 'drizzle-orm'

import { db, captureForms, dealEvents, deals, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { ingestLead } from '@/lib/leads/ingest'
import { getPublicCaptureForm } from '@/lib/capture/public'
import { sendCaptureAiIntro } from '@/lib/capture/ai-intro'
import { enrollContactInCadence } from '@/lib/cadences/cadence'
import {
  generateQuizResult,
  type QuizAiOutcome,
  type QuizAnswer,
} from '@/lib/capture/quiz-result'
import { setContactTags, loadTagsByContact } from '@/lib/api/v1/contacts'

export const dynamic = 'force-dynamic'

const DEFAULT_RESULT =
  'Recebemos suas respostas! 🎉 Nossa equipe já está analisando e vai te chamar no WhatsApp com as recomendações.'

/** Teto da geração de IA — o lead não fica olhando spinner pra sempre. */
const AI_TIMEOUT_MS = 25_000

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body) return NextResponse.json({ ok: false }, { status: 400 })

    // Honeypot: bot preencheu o campo escondido → finge sucesso, não cria nada.
    if (typeof body.site === 'string' && body.site.trim()) {
      return NextResponse.json({ ok: true, result: DEFAULT_RESULT })
    }

    const slug = body.slug
    if (typeof slug !== 'string') {
      return NextResponse.json({ ok: false, error: 'Quiz inválido.' }, { status: 400 })
    }
    const form = await getPublicCaptureForm(slug)
    if (!form || form.content.mode !== 'quiz') {
      return NextResponse.json(
        { ok: false, error: 'Quiz indisponível.' },
        { status: 404 },
      )
    }
    const questions = form.content.quiz.questions
    if (!questions.length) {
      return NextResponse.json(
        { ok: false, error: 'Quiz sem perguntas.' },
        { status: 400 },
      )
    }

    // Respostas: array alinhado às perguntas (choice = uma das opções).
    const rawAnswers = Array.isArray(body.answers) ? body.answers : null
    if (!rawAnswers || rawAnswers.length !== questions.length) {
      return NextResponse.json(
        { ok: false, error: 'Responda todas as perguntas.' },
        { status: 400 },
      )
    }
    const answers: QuizAnswer[] = []
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const a = typeof rawAnswers[i] === 'string' ? (rawAnswers[i] as string).trim() : ''
      if (q.type === 'choice') {
        if (!q.options.includes(a)) {
          return NextResponse.json(
            { ok: false, error: `Responda: ${q.text}` },
            { status: 400 },
          )
        }
      } else if (a.length > 500) {
        return NextResponse.json(
          { ok: false, error: 'Resposta longa demais.' },
          { status: 400 },
        )
      }
      answers.push({ question: q.text, answer: a || '(sem resposta)' })
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
    // WhatsApp COM DDD (com ou sem +55) — sem DDD o número é inútil.
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

    const answersBlock = answers
      .map((a, i) => `${i + 1}. ${a.question}\n   → ${a.answer}`)
      .join('\n')
    const notes = `🧠 Quiz "${form.name}" — respostas:\n${answersBlock}`

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
      origin: form.origin || 'Quiz',
      source: `Quiz: ${form.name}`,
      taskSuffix: 'quiz',
    })

    await db
      .update(captureForms)
      .set({ submissions: sql`submissions + 1` })
      .where(eq(captureForms.id, form.id))

    // Diagnóstico com IA (na tela) + qualificação (pro vendedor) — com teto de
    // tempo; falhou/estourou → texto de fallback e a vida segue.
    let outcome: QuizAiOutcome | null = null
    if (form.content.quiz.aiResult) {
      outcome = await Promise.race([
        generateQuizResult({
          accountId: form.accountId,
          quizName: form.name,
          resultPrompt: form.content.quiz.resultPrompt,
          answers,
          leadName: nome || null,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), AI_TIMEOUT_MS)),
      ])
    }

    if (outcome) {
      const audit = auditUser
      const done = outcome
      // Qualificação → histórico do card + notas + etiqueta (best-effort, fora
      // do request — o lead não espera bookkeeping interno).
      after(async () => {
        const emoji =
          done.qualification === 'quente'
            ? '🔥'
            : done.qualification === 'frio'
              ? '❄️'
              : '🌤️'
        const label = done.qualification
          ? `${emoji} IA qualificou (quiz): ${done.qualification.toUpperCase()}`
          : '🧠 Diagnóstico do quiz gerado pela IA'
        const block = [label, done.sellerSummary, `Diagnóstico mostrado ao lead:\n${done.result}`]
          .filter(Boolean)
          .join('\n')
        if (lead.dealId) {
          try {
            await db.insert(dealEvents).values({
              accountId: form.accountId,
              dealId: lead.dealId,
              actorUserId: audit,
              type: 'note',
              data: { text: block },
            })
            await db
              .update(deals)
              .set({ notes: sql`coalesce(${deals.notes}, '') || ${'\n\n' + block}` })
              .where(eq(deals.id, lead.dealId))
          } catch (err) {
            console.error('[quiz submit] anotação da qualificação falhou:', err)
          }
        }
        if (done.qualification && lead.contactId) {
          try {
            const current = (
              (await loadTagsByContact([lead.contactId])).get(lead.contactId) ?? []
            ).map((t) => t.name)
            const tag = `Quiz: ${done.qualification}`
            if (!current.includes(tag)) {
              // Uma qualificação por vez: sai a antiga do quiz, entra a nova.
              const rest = current.filter((t) => !t.startsWith('Quiz: '))
              await setContactTags(form.accountId, audit, lead.contactId, [
                ...rest,
                tag,
              ])
            }
          } catch (err) {
            console.error('[quiz submit] etiqueta da qualificação falhou:', err)
          }
        }
      })
    }

    // Obrigado que Vende: cadência automática pra quem envia (best-effort).
    if (form.cadenceId && lead.contactId) {
      const cadenceId = form.cadenceId
      after(async () => {
        try {
          await enrollContactInCadence(
            { accountId: form.accountId, userId: auditUser },
            { cadenceId, contactId: lead.contactId, dealId: lead.dealId },
          )
        } catch (err) {
          console.error('[quiz submit] cadência falhou:', err)
        }
      })
    }

    // IA no Segundo Zero: primeira mensagem no WhatsApp citando o quiz.
    if (form.aiIntro) {
      const resumo = answers
        .map((a) => `${a.question}: ${a.answer}`)
        .join(' | ')
        .slice(0, 600)
      after(() =>
        sendCaptureAiIntro({
          accountId: form.accountId,
          formName: form.name,
          channelId: form.introChannelId,
          phone,
          name: nome || null,
          company: empresa || null,
          email: email || null,
          message: `Respostas do quiz — ${resumo}`,
        }),
      )
    }

    const fallback =
      form.content.quiz.resultFallback || form.successMessage || DEFAULT_RESULT
    return NextResponse.json({
      ok: true,
      result: outcome?.result || fallback,
      ai: !!outcome,
    })
  } catch (err) {
    console.error('[quiz submit]', err)
    return NextResponse.json({ ok: false, error: 'Falha ao enviar.' }, { status: 500 })
  }
}
