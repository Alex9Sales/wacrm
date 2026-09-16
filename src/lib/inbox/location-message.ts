// ============================================================
// A mensagem É uma localização — e não um texto que só CONTÉM um link do Maps?
// Só nesse caso a bolha vira cartão de mapa: um acerto errado esconde a
// mensagem inteira. 16/09 (Família do Gás): o aviso "IA TRANSFERIU PRA HUMANO"
// trazia o pino da cliente no resumo e apareceu no CRM como um cartão
// "📍 Localização", sem motivo nem resumo.
//
// Formatos que viram cartão (os que o próprio CRM grava):
//   • WAHA (providers/waha.ts textFromLocation):
//       "📍 Localização[ em tempo real]\n[lugar\n]https://www.google.com/maps?q=LAT,LNG"
//   • pino enviado pelo CRM (whatsapp/location.ts mapsLink): só o link
//   • localização de grupo, com o autor na frente ("João: 📍 Localização\n…"),
//     inclusive quando encaminhada para uma conversa 1:1
// Qualquer texto a mais → texto normal (o RichText já deixa o link clicável).
// Puro, sem React e sem 'server-only': o worker também usa (resumo de aviso).
// ============================================================

export interface LocationMessage {
  header: string
  place?: string
  url: string
}

/** Link do Google Maps com q=LAT,LNG ocupando a linha INTEIRA. Só os hosts do
 *  Google — "google.com.evil.io/maps?q=…" não vira "Abrir no Google Maps". */
export const MAPS_PIN_URL_RE =
  /^https?:\/\/(?:www\.|maps\.)?google\.com(?:\.br)?\/(?:maps\/?)?\?(?:[^\s#@]*&)?q=-?\d{1,3}(?:\.\d+)?(?:,|%2C)-?\d{1,3}(?:\.\d+)?(?:&[^\s@]*)?$/i

const HEADER_RE = /^📍 Localização(?: em tempo real)?$/u
/** Autor de grupo (prefixGroupAuthor, "Nome: ") seguido do cabeçalho exato
 *  no FIM da 1ª linha — aceita nome com ":" ("Maria :)"). */
const AUTHOR_HEADER_RE = /^(.{1,80}): (📍 Localização(?: em tempo real)?)$/u
/** Nome do lugar + endereço do WhatsApp: no máximo duas linhas, texto curto. */
const MAX_PLACE_LINES = 2
const MAX_PLACE_LEN = 200

export function detectLocationMessage(txt: string | null | undefined): LocationMessage | null {
  let body = (txt ?? '').replace(/\r\n?/g, '\n').trim()
  if (!body) return null

  // Autor de grupo só quando o que vem depois é o cabeçalho EXATO — "Cliente
  // disse: 📍 …" num aviso não passa, porque a linha não é só o cabeçalho.
  let author: string | undefined
  const firstLine = body.split('\n')[0].trim()
  const a = HEADER_RE.test(firstLine) ? null : firstLine.match(AUTHOR_HEADER_RE)
  if (a) {
    author = a[1]
    body = body.slice(a[1].length + 2)
  }

  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return null

  const url = lines[lines.length - 1]
  if (!MAPS_PIN_URL_RE.test(url)) return null // a última linha é SÓ o link

  if (lines.length === 1) {
    // Link puro (pino enviado pelo CRM). Com autor não chega aqui: o autor só
    // é aceito seguido do cabeçalho.
    return { header: '📍 Localização', url }
  }

  if (!HEADER_RE.test(lines[0])) return null // cabeçalho exato do WAHA
  const middle = lines.slice(1, -1)
  if (middle.length > MAX_PLACE_LINES) return null
  const place = middle.join(' · ')
  if (place.length > MAX_PLACE_LEN || /https?:\/\/|📍/iu.test(place)) return null

  return {
    header: author ? `${author}: ${lines[0]}` : lines[0],
    ...(place ? { place } : {}),
    url,
  }
}
