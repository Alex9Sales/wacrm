'use server'

// ============================================================
// 🎯 Prospecção assistida (social selling — Peça 2).
// A API oficial NÃO deixa mandar DM fria. Então a IA faz o trabalho pesado:
// lê o perfil de cada @ (bio, seguidores via Business Discovery), qualifica
// contra o cliente ideal e ESCREVE a 1ª abordagem personalizada. O humano
// copia e envia manualmente. Sem envio automático, sem scraping.
// ============================================================

import { and, asc, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'
import { loadChannelByAccount } from '@/lib/channels/channels'
import { fetchBusinessDiscovery } from '@/lib/channels/providers/instagram'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'

/** Cliente ideal padrão da Fluxia (fallback do servidor — a tela também
 *  manda o critério que o usuário editar). NÃO exportar: arquivo 'use server'
 *  só pode exportar funções async. */
const DEFAULT_ICP =
  'Donos, sócios ou gestores de pequenas e médias empresas, autônomos, clínicas, ' +
  'comércios e prestadores de serviço que atendem clientes por WhatsApp/Instagram e ' +
  'perdem venda por demora na resposta, follow-up esquecido ou atendimento ' +
  'desorganizado — gente que se beneficiaria de organizar e automatizar o atendimento ' +
  'e o comercial com IA. NÃO é cliente ideal: perfil pessoal sem negócio; concorrente ' +
  '(outra agência de marketing/automação ou outro CRM); quem só procura emprego; conta ' +
  'claramente fora do Brasil.'

/** Quantos @s analisar por vez (segura o tempo do server action). */
const MAX_HANDLES = 10

export type Verdict = 'quente' | 'morno' | 'frio' | 'fora'

export interface ProspectResult {
  handle: string
  found: boolean
  name: string | null
  bio: string | null
  followers: number | null
  posts: number | null
  qualified: boolean
  verdict: Verdict
  reason: string
  message: string | null
}

export interface ProspectChannel {
  id: string
  name: string
}

/** Canais Instagram da conta (pro seletor de qual perfil usa o Business Discovery). */
export async function listProspectChannels(): Promise<ProspectChannel[]> {
  const ctx = await getCurrentAccount()
  return db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(
      and(eq(channels.accountId, ctx.accountId), eq(channels.provider, 'instagram')),
    )
    .orderBy(asc(channels.createdAt))
}

const VALID_VERDICTS: Verdict[] = ['quente', 'morno', 'frio', 'fora']

/** Uma linha colada = @handle (1º token) + nota livre opcional (o resto).
 *  Ex.: "@padaria.donana padaria de bairro que vende pelo zap" →
 *       { handle: 'padaria.donana', note: 'padaria de bairro que vende pelo zap' } */
function parseEntry(raw: string): { handle: string; note: string } {
  const line = (raw ?? '').trim()
  if (!line) return { handle: '', note: '' }
  const firstSpace = line.search(/\s/)
  const head = firstSpace === -1 ? line : line.slice(0, firstSpace)
  const note = firstSpace === -1 ? '' : line.slice(firstSpace + 1).trim()
  const urlMatch = head.match(/instagram\.com\/([A-Za-z0-9._]+)/i)
  const handle = (urlMatch ? urlMatch[1] : head)
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._]/g, '')
    .toLowerCase()
  return { handle, note }
}

async function analyzeOne(
  ch: Awaited<ReturnType<typeof loadChannelByAccount>>,
  config: NonNullable<Awaited<ReturnType<typeof loadAiConfig>>>,
  criteria: string,
  handle: string,
  note: string,
): Promise<ProspectResult> {
  const base: ProspectResult = {
    handle,
    found: false,
    name: null,
    bio: null,
    followers: null,
    posts: null,
    qualified: false,
    verdict: 'frio',
    reason: '',
    message: null,
  }
  try {
    const disco = ch ? await fetchBusinessDiscovery(ch, handle) : null
    // Business Discovery só enxerga conta business/creator. Perfil pessoal não
    // é descobrível — seguimos com abordagem mais genérica.
    const name = disco?.name ?? null
    const bio = disco?.biography ?? null
    const followers = disco?.followersCount ?? null
    const posts = disco?.mediaCount ?? null
    base.found = !!disco
    base.name = name
    base.bio = bio
    base.followers = followers
    base.posts = posts

    const perfil = [
      `@${handle}`,
      name ? `Nome: ${name}` : null,
      bio ? `Bio: ${bio}` : null,
      typeof followers === 'number' ? `Seguidores: ${followers}` : null,
      typeof posts === 'number' ? `Posts: ${posts}` : null,
      disco
        ? 'Tipo de conta: profissional/criador (lida pela API).'
        : 'A bio e os seguidores não puderam ser lidos automaticamente.',
      note ? `O que a gente sabe do negócio (anotação de quem vai prospectar): ${note}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    const systemPrompt = [
      'Você é um especialista em prospecção B2B da Fluxia — um CRM com agentes de IA que atende clientes no WhatsApp e no Instagram, responde em segundos, faz follow-up sozinho e organiza o funil de vendas.',
      'Analise o perfil de Instagram abaixo e faça três coisas:',
      '1. Diga se a pessoa/empresa se encaixa no CLIENTE IDEAL (qualificado true/false).',
      '2. Classifique o potencial: "quente" (cara do cliente ideal, dor clara), "morno" (pode ser, sem certeza), "frio" (improvável) ou "fora" (claramente não é cliente ideal: perfil pessoal, concorrente, etc.).',
      '3. Escreva UMA mensagem de primeira abordagem (DM), curta (2 a 4 linhas), humana e PERSONALIZADA: cite algo REAL do perfil (o tipo de negócio, o que a pessoa faz) e conecte com a dor que a Fluxia resolve (perder venda por demora no atendimento, follow-up esquecido, atendimento desorganizado). Termine com uma pergunta leve que puxe resposta. Nada de spam, nada de "olá, conheça nosso produto", nada de parecer robô ou modelo de mensagem. Soe como uma pessoa de verdade puxando papo com um dono de negócio.',
      'Se o verdict for "fora", deixe a mensagem vazia.',
      'Personalize a partir do que você TEM: se veio a anotação de quem vai prospectar (o que é o negócio), use isso pra deixar a mensagem específica. Se você só tem o @ e nenhuma info, escreva uma abordagem mais leve — sem inventar detalhes que você não viu — e classifique com cautela.',
      '',
      'CLIENTE IDEAL:',
      criteria,
      '',
      'Responda SÓ com um JSON, nada mais: {"qualificado": true|false, "verdict": "quente|morno|frio|fora", "motivo": "bem curto", "mensagem": "a DM ou string vazia"}.',
    ].join('\n')

    const res = await generateReply({
      config,
      systemPrompt,
      messages: [{ role: 'user', content: perfil }],
    })
    const raw = (res.text ?? '').trim()
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        const j = JSON.parse(m[0]) as {
          qualificado?: boolean
          verdict?: string
          motivo?: string
          mensagem?: string
        }
        if (typeof j.qualificado === 'boolean') base.qualified = j.qualificado
        if (j.verdict && VALID_VERDICTS.includes(j.verdict as Verdict)) {
          base.verdict = j.verdict as Verdict
        }
        if (j.motivo) base.reason = String(j.motivo).slice(0, 200)
        const msg = (j.mensagem ?? '').trim()
        base.message = base.verdict === 'fora' ? null : msg || null
      } catch {
        base.reason = 'não consegui interpretar a análise'
      }
    } else {
      base.reason = 'sem análise'
    }
  } catch (e) {
    base.reason = `erro: ${(e as Error).message.slice(0, 120)}`
  }
  return base
}

export async function analyzeProspects(input: {
  channelId: string
  criteria: string
  entries: string[]
}): Promise<ProspectResult[]> {
  const ctx = await getCurrentAccount()
  const ch = await loadChannelByAccount(ctx.accountId, input.channelId)
  if (!ch) throw new Error('Canal Instagram não encontrado.')
  const config = await loadAiConfig(ctx.accountId, { requireActive: false })
  if (!config) throw new Error('Configure um agente de IA na conta primeiro.')

  // Parse handle + nota, dedup por handle (mantém a 1ª nota), corta em MAX.
  const byHandle = new Map<string, string>()
  for (const raw of input.entries) {
    const { handle, note } = parseEntry(raw)
    if (!handle || byHandle.has(handle)) continue
    byHandle.set(handle, note)
    if (byHandle.size >= MAX_HANDLES) break
  }
  if (byHandle.size === 0) return []
  const criteria = input.criteria.trim() || DEFAULT_ICP

  // Paralelo: cada @ é 1 chamada Graph + 1 LLM. Até MAX_HANDLES cabe no tempo.
  return Promise.all(
    Array.from(byHandle.entries()).map(([h, note]) =>
      analyzeOne(ch, config, criteria, h, note),
    ),
  )
}
