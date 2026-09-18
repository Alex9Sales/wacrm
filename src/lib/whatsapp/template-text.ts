// ============================================================
// Texto que o cliente LEU num template: o corpo aprovado com {{1}}, {{2}}…
// preenchidos. Puro (client-safe).
//
// Zelo 18/09: template enviado pelo sistema (abertura de lead do RD, teste do
// número oficial) era gravado SEM texto — na conversa aparecia uma bolha vazia
// e, na lista, só "📋 Modelo". Só o envio feito pela tela guardava o texto.
// ============================================================

/** Variável sem valor fica como está ("{{2}}"), pra não esconder o buraco. */
export function renderTemplateText(
  body: string | null | undefined,
  params: string[] | null | undefined,
): string {
  const text = (body ?? '').trim()
  if (!text) return ''
  const values = params ?? []
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, raw: string) => {
    const v = values[Number(raw) - 1]
    return typeof v === 'string' && v !== '' ? v : whole
  })
}
