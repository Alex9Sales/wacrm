// ============================================================
// 📎 Materiais do agente — parte PURA (tipos, parser do [[ENVIAR:nome]] e o
// bloco do prompt). Client-safe: defaults.ts é importado por componentes do
// painel, então NADA de '@/db' aqui (o build do browser quebrou com 7 erros
// quando materials.ts com db entrou nessa cadeia, 01/09).
// ============================================================

export type MaterialKind = 'image' | 'video' | 'document'

export interface AgentMaterial {
  id: string
  name: string
  description: string | null
  mediaType: MaterialKind
  mediaUrl: string
  filename: string | null
  mimetype: string | null
}

/** Marcador: [[ENVIAR:nome]] (case-insensitive, espaços tolerados). */
const MATERIAL_DIRECTIVE = /\[\[\s*ENVIAR\s*:\s*([^\]]+?)\s*\]\]/gi

/**
 * Tira TODOS os `[[ENVIAR:nome]]` do texto e devolve os nomes na ordem.
 * Tolerante à posição (fim de linha, linha própria, no meio) — o texto que
 * sobra é o que vai pro cliente.
 */
export function extractMaterialDirectives(raw: string): { text: string; names: string[] } {
  const names: string[] = []
  const lines = raw.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    let had = false
    const stripped = line.replace(MATERIAL_DIRECTIVE, (_m, name: string) => {
      had = true
      const n = name.trim()
      if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n)
      return ''
    })
    // Linha que era SÓ o marcador some; linha com texto fica (sem espaço sobrando).
    if (had && !stripped.trim()) continue
    kept.push(had ? stripped.replace(/\s{2,}/g, ' ').trimEnd() : line)
  }
  return { text: kept.join('\n').trim(), names }
}

/** Acha o material pelo nome escrito pela IA (case-insensitive; aceita prefixo único). */
export function findMaterialByName(
  materials: AgentMaterial[],
  name: string,
): AgentMaterial | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const exact = materials.find((m) => m.name.toLowerCase() === n)
  if (exact) return exact
  const partial = materials.filter(
    (m) => m.name.toLowerCase().startsWith(n) || n.startsWith(m.name.toLowerCase()),
  )
  return partial.length === 1 ? partial[0] : null
}

const KIND_LABEL: Record<MaterialKind, string> = {
  image: 'image',
  video: 'video',
  document: 'document',
}

/** Bloco do prompt: ensina o marcador e lista os materiais (nome exato). */
export function materialsInstruction(materials: AgentMaterial[]): string {
  if (materials.length === 0) return ''
  const list = materials
    .map(
      (m) =>
        `- "${m.name}" (${KIND_LABEL[m.mediaType]}${m.filename ? `, ${m.filename}` : ''})${
          m.description?.trim() ? ` — ${m.description.trim()}` : ''
        }`,
    )
    .join('\n')
  return (
    'You can SEND FILES the business prepared (documents, images, videos). To send one, write the marker [[ENVIAR:<exact name>]] on its own line, anywhere in your reply — the system removes the marker and delivers the file right after your text. ' +
    'Send a file only when the business instructions say so or when the customer asks for it; introduce it in one short sentence (e.g. "Segue o documento 👇"); never claim you sent something without the marker; never invent names not in this list; avoid sending the same file twice in a conversation unless the customer asks again or the business instructions explicitly say to resend (e.g. together with a meeting confirmation). ' +
    'Available files:\n' +
    list
  )
}
