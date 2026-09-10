// ============================================================
// Erro de tela no navegador → log do servidor (09/09/2026).
//
// A tela "Algo deu errado ao carregar esta tela" (app/(dashboard)/error.tsx)
// só escrevia no console do navegador do cliente — Renato (Limpeza com Zelo)
// e Wilian (GoLink) viam a tela "toda hora" e do nosso lado não havia rastro
// (log do web zerado). Aqui o error boundary manda mensagem/stack/URL/build e
// o worker de plantão lê no `docker logs`. Sem sessão obrigatória (a tela pode
// cair justamente porque a sessão morreu); tamanho e taxa limitados.
// ============================================================

import { NextResponse } from 'next/server'

import { getBuildId } from '@/lib/version'

export const dynamic = 'force-dynamic'

const MAX_BODY = 8_000
const bucket = new Map<string, { n: number; at: number }>()

function allow(ip: string): boolean {
  const now = Date.now()
  const b = bucket.get(ip)
  if (!b || now - b.at > 60_000) {
    bucket.set(ip, { n: 1, at: now })
    return true
  }
  b.n += 1
  return b.n <= 20
}

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (!allow(ip)) return NextResponse.json({ ok: false }, { status: 429 })
  let raw = ''
  try {
    raw = (await request.text()).slice(0, MAX_BODY)
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    /* corpo inválido → registra cru */
  }
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')
  console.error(
    '[client-error]',
    JSON.stringify({
      message: str(body.message, 500),
      digest: str(body.digest, 80),
      url: str(body.url, 300),
      clientBuild: str(body.buildId, 64),
      serverBuild: getBuildId(),
      ua: str(request.headers.get('user-agent'), 160),
      stack: str(body.stack, 1_500),
    }),
  )
  return NextResponse.json({ ok: true })
}
