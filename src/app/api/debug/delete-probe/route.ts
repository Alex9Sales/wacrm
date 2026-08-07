import { NextResponse } from 'next/server'

// Capturador TEMPORÁRIO do "excluir conversa não apaga" (conta do Rafael):
// o cliente manda pra cá ANTES de chamar deleteConversation, e de novo
// no resultado/erro. Assim vemos no log do servidor se o handler roda, qual
// papel o cliente enxerga (accountRole), e o desfecho — mesmo quando a server
// action não chega a ser invocada. Público de propósito (só loga, sem dado
// sensível). REMOVER depois de diagnosticar.
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: Record<string, unknown> = {}
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    /* corpo inválido — loga vazio */
  }
  console.log(
    `[delete-probe] stage=${body.stage ?? '?'} role=${body.role ?? '?'} ` +
      `conv=${body.conversationId ?? '?'} deleted=${body.deleted ?? '-'} ` +
      `err=${typeof body.message === 'string' ? body.message.slice(0, 200) : '-'} ` +
      `from=${body.from ?? '?'}`,
  )
  return NextResponse.json({ ok: true })
}
