// Abertura de lead em mensagens curtas (Alex 18/09: "dá uma quebrada, tá
// grande"). Na config da fonte, uma linha só com "---" separa as mensagens.
// Pura — sem banco — pra testar e reusar.

export function splitIntroParts(text: string): string[] {
  return text
    .split(/\n[ \t]*---[ \t]*(?:\n|$)/)
    .map((p) => p.trim())
    .filter(Boolean)
}
