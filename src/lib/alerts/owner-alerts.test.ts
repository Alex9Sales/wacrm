import { beforeEach, describe, expect, it, vi } from 'vitest'

// 02/10/2026 (revisão do aviso de transferência parada): o envio passa a dizer
// se chegou a CHAMAR o canal. Falha depois disso é ambígua (pode ter saído);
// falha antes é certa. Configuração, canais e provedor são falsos.
const h = vi.hoisted(() => ({
  settings: vi.fn(),
  channels: vi.fn(),
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
}))
vi.mock('@/lib/settings/account-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/settings/account-settings')>()),
  getAccountSettings: h.settings,
}))
vi.mock('@/lib/channels/channels', () => ({ listChannels: h.channels }))
vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({ sendText: h.sendText, sendTemplate: h.sendTemplate }),
}))
vi.mock('@/lib/ai/self-message', () => ({ markSelfMessage: async () => {} }))

import { flattenForTemplate, sendOwnerAlert } from './owner-alerts'
import { DEFAULT_ACCOUNT_SETTINGS } from '@/lib/settings/account-settings'

// 17/09 (Limpeza com Zelo): o resumo da reunião vai pro WhatsApp do dono por um
// canal OFICIAL da Meta. Fora da janela de 24h só passa template, e variável de
// template não aceita quebra de linha.
describe('aviso do dono em uma linha (template)', () => {
  it('quebra de linha vira " · " e espaço demais some', () => {
    const t = flattenForTemplate('🗓️ *REUNIÃO MARCADA*\n\n👤 Karen · 5511999\n📋 São Paulo    R$ 30 mil')
    expect(t).not.toMatch(/[\n\t]/)
    expect(t).not.toMatch(/ {3}/)
    expect(t).toContain('🗓️ *REUNIÃO MARCADA* · 👤 Karen · 5511999 · 📋 São Paulo R$ 30 mil')
  })

  it('texto longo é cortado com reticências', () => {
    const t = flattenForTemplate('a'.repeat(1200))
    expect(t.length).toBeLessThanOrEqual(900)
    expect(t.endsWith('…')).toBe(true)
  })
})

describe('resultado do envio — chegou a chamar o canal?', () => {
  const VARS = { cliente: 'Paciente Exemplo', telefone: '5511900000001', tempo: '20 min', motivo: '', link: '' }
  const CONTA = {
    ...DEFAULT_ACCOUNT_SETTINGS,
    alertPhone: '5511900000000',
    alertOnHandoffStalled: true,
  }

  beforeEach(() => {
    h.settings.mockReset().mockResolvedValue(CONTA)
    h.channels.mockReset().mockResolvedValue([{ id: 'canal-1', provider: 'waha' }])
    h.sendText.mockReset().mockResolvedValue(undefined)
    h.sendTemplate.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('saiu', async () => {
    expect(await sendOwnerAlert('conta-1', 'handoff_stalled', VARS)).toEqual({ ok: true, tentou: true })
    expect(h.sendText).toHaveBeenCalledTimes(1)
  })

  it('o canal lançou (ex.: WAHA estourou o tempo): falha AMBÍGUA, tentou=true', async () => {
    h.sendText.mockRejectedValueOnce(new Error('timeout de 15 s'))
    expect(await sendOwnerAlert('conta-1', 'handoff_stalled', VARS)).toEqual({
      ok: false,
      tentou: true,
      falha: 'erro',
    })
  })

  it('texto recusado mas o template salvou: saiu', async () => {
    h.settings.mockResolvedValue({ ...CONTA, alertTemplateName: 'aviso_dono' })
    h.sendText.mockRejectedValueOnce(new Error('fora da janela de 24h'))
    expect(await sendOwnerAlert('conta-1', 'handoff_stalled', VARS)).toEqual({ ok: true, tentou: true })
    expect(h.sendTemplate).toHaveBeenCalledTimes(1)
  })

  it('sem canal WhatsApp: falha certa, antes do envio', async () => {
    h.channels.mockResolvedValue([{ id: 'canal-ig', provider: 'instagram' }])
    expect(await sendOwnerAlert('conta-1', 'handoff_stalled', VARS)).toEqual({
      ok: false,
      tentou: false,
      falha: 'sem_canal',
    })
    expect(h.sendText).not.toHaveBeenCalled()
  })

  it('aviso desligado ou sem telefone: falha certa, antes do envio', async () => {
    h.settings.mockResolvedValue({ ...CONTA, alertOnHandoffStalled: false })
    expect(await sendOwnerAlert('conta-1', 'handoff_stalled', VARS)).toEqual({
      ok: false,
      tentou: false,
      falha: 'desligado',
    })
    h.settings.mockResolvedValue({ ...CONTA, alertPhone: '' })
    expect((await sendOwnerAlert('conta-1', 'handoff_stalled', VARS)).falha).toBe('desligado')
  })

  it('banco fora antes de chamar o canal: erro, mas nada saiu (tentou=false)', async () => {
    h.channels.mockRejectedValueOnce(new Error('conexão recusada'))
    expect(await sendOwnerAlert('conta-1', 'handoff_stalled', VARS)).toEqual({
      ok: false,
      tentou: false,
      falha: 'erro',
    })
  })
})
