import { NextResponse } from 'next/server'

import { applyAsaasEvent, connectionByWebhookToken, type AsaasWebhookBody } from '@/lib/collections/webhook'

// ============================================================
// 🧾 Fase 4 — webhook do Asaas DO CLIENTE: pagou, para de cobrar.
//
// NÃO confundir com /api/webhooks/asaas, que é o da NOSSA assinatura Fluxia.
// Aqui a URL carrega um token por CONEXÃO: o cliente cola uma URL por conta do
// Asaas, e um token vazado não alcança as outras contas nem os outros clientes.
//
// Devolve 200 para tudo que for autenticado, inclusive evento repetido ou
// desconhecido: o Asaas reenvia quando não recebe 200 e acaba desativando a
// fila do cliente se a gente responder erro por algo que não é erro.
// ============================================================

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const conn = await connectionByWebhookToken(token)
  // Token inválido não ganha detalhe nenhum — nem "conexão não existe".
  if (!conn) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let body: AsaasWebhookBody
  try {
    body = (await req.json()) as AsaasWebhookBody
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  try {
    const out = await applyAsaasEvent(conn.id, conn.accountId, body)
    if (out.cancelledRequests > 0) {
      console.log(
        `[cobranca webhook] ${conn.label}: ${body.event} → ${out.cancelledRequests} cobrança(s) pendente(s) cancelada(s) antes de sair`,
      )
    }
    return NextResponse.json({ ok: true, action: out.action })
  } catch (err) {
    // Erro nosso: devolvemos 500 de propósito para o Asaas REENVIAR. Perder um
    // aviso de pagamento significa cobrar alguém que já pagou.
    console.error('[cobranca webhook] falhou:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

/** O Asaas testa a URL antes de salvar; responder aqui evita "URL inválida". */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const conn = await connectionByWebhookToken(token)
  if (!conn) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
