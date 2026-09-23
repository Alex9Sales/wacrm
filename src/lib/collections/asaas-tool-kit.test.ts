import { describe, expect, it } from 'vitest'

import { ASAAS_AUTH_HEADER, ASAAS_KIT, asaasKitInstalledCount, isAsaasKitSlug, planAsaasKit } from './asaas-tool-kit'

const PROD = 'https://api.asaas.com/v3'

describe('kit de ferramentas do Asaas', () => {
  it('monta a URL na raiz da conexão, sem barra dobrada', () => {
    const plano = planAsaasKit(PROD)
    expect(plano).toHaveLength(ASAAS_KIT.length)
    for (const t of plano) expect(t.url.startsWith(`${PROD}/`)).toBe(true)
    expect(planAsaasKit('https://api-sandbox.asaas.com/v3/')[0].url).toContain('https://api-sandbox.asaas.com/v3/payments')
    expect(planAsaasKit(PROD).some((t) => t.url.includes('//payments'))).toBe(false)
  })

  it('todo {placeholder} da URL é um parâmetro declarado — senão a IA nunca preenche', () => {
    for (const t of planAsaasKit(PROD)) {
      const usados = [...t.url.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1])
      expect(usados.length).toBeGreaterThan(0)
      for (const u of usados) expect(t.params.map((p) => p.name)).toContain(u)
      // E todo parâmetro declarado aparece na URL (nenhum pedido à toa).
      for (const p of t.params) expect(usados).toContain(p.name)
    }
  })

  it('parâmetro de URL é sempre obrigatório (o Asaas recusa filtro vazio)', () => {
    for (const t of ASAAS_KIT) for (const p of t.params) expect(p.required).toBe(true)
  })

  it('slugs fixos e únicos: reinstalar atualiza, não duplica', () => {
    const slugs = ASAAS_KIT.map((t) => t.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const s of slugs) expect(isAsaasKitSlug(s)).toBe(true)
    expect(isAsaasKitSlug('buscar_cliente')).toBe(false)
    // 🔒 Busca livre por documento/nome não entra no kit (revisão 23/09).
    expect(isAsaasKitSlug('asaas_cliente_por_documento')).toBe(false)
    expect(ASAAS_KIT.every((k) => k.params.every((p) => /^id_/.test(p.name) || p.name === 'status'))).toBe(true)
  })

  it('conta o que já está instalado, ignorando as ferramentas do cliente', () => {
    expect(asaasKitInstalledCount([])).toBe(0)
    expect(asaasKitInstalledCount(['consultar_estoque', 'asaas_pix_da_cobranca'])).toBe(1)
    expect(asaasKitInstalledCount(ASAAS_KIT.map((t) => t.slug))).toBe(ASAAS_KIT.length)
  })

  it('o header do Asaas é access_token, não Authorization (401 clássico)', () => {
    expect(ASAAS_AUTH_HEADER).toBe('access_token')
  })

  it('só leitura: o kit não tem nada que crie ou altere cobrança', () => {
    for (const t of ASAAS_KIT) expect(t.method).toBe('GET')
  })
})
