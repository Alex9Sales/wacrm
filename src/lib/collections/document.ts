// ============================================================
// CPF/CNPJ — validação e leitura de documento dentro de um texto.
//
// 08/09: o Asaas de PRODUÇÃO exige CPF ou CNPJ do cliente pra gerar qualquer
// cobrança ("Para criar esta cobrança é necessário preencher o CPF ou CNPJ do
// cliente"). O dono manda o número num balão ("03289662152") e o CRM precisa
// reconhecer que aquilo é um documento — e NÃO confundir com telefone (11
// dígitos também). Por isso valida os dígitos verificadores: um celular com
// DDD quase nunca passa como CPF.
// Puro (sem banco) — importável por teste e por client.
// ============================================================

export function onlyDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '')
}

export function isValidCpf(raw: string): boolean {
  const d = onlyDigits(raw)
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false
  const dv = (len: number) => {
    let sum = 0
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i)
    const r = (sum * 10) % 11
    return r === 10 ? 0 : r
  }
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10])
}

export function isValidCnpj(raw: string): boolean {
  const d = onlyDigits(raw)
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false
  const dv = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    let sum = 0
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i]
    const r = sum % 11
    return r < 2 ? 0 : 11 - r
  }
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13])
}

/** CPF ou CNPJ válido → só dígitos; senão null. */
export function normalizeValidDocument(raw: string | null | undefined): string | null {
  const d = onlyDigits(raw)
  if (d.length === 11 && isValidCpf(d)) return d
  if (d.length === 14 && isValidCnpj(d)) return d
  return null
}

/**
 * Primeiro CPF/CNPJ VÁLIDO que aparece no texto (com ou sem pontuação).
 * Telefone com DDD (11 dígitos) só passa se, por azar, os verificadores
 * baterem — improvável; celular com 55 na frente tem 13 e nem entra.
 */
export function findDocumentInText(text: string | null | undefined): string | null {
  if (!text) return null
  const re = /\d[\d.\-\/ ]{9,20}\d/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const doc = normalizeValidDocument(m[0])
    if (doc) return doc
    // Um bloco longo pode conter o documento colado a outros números: tenta as janelas.
    const d = onlyDigits(m[0])
    for (const len of [11, 14]) {
      for (let i = 0; i + len <= d.length; i++) {
        const w = normalizeValidDocument(d.slice(i, i + len))
        if (w) return w
      }
    }
  }
  return null
}

/** Documento parcialmente oculto (só início e verificadores) — pra confirmar sem expor. */
export function maskDocument(doc: string): string {
  const d = onlyDigits(doc)
  if (d.length === 11) return `${d.slice(0, 3)}.***.***-${d.slice(9)}`
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.***/****-${d.slice(12)}`
  return d ? `${d.slice(0, 2)}***${d.slice(-2)}` : ''
}
