import { describe, expect, it } from 'vitest'

import { isAppPath } from './protected-paths'

describe('isAppPath', () => {
  it('telas da área logada exigem sessão', () => {
    for (const p of ['/inbox', '/inbox?x=1'.split('?')[0], '/settings', '/settings/', '/supervisao', '/pipelines/abc', '/admin/suporte', '/dashboard']) {
      expect(isAppPath(p)).toBe(true)
    }
  })
  it('rotas públicas seguem livres', () => {
    for (const p of ['/', '/login', '/signup', '/forgot-password', '/f/fluxia', '/proposta/123', '/agendar', '/join/tok', '/diagnostico', '/privacidade', '/termos', '/custom-domain/x', '/widget.js', '/api/public/x']) {
      expect(isAppPath(p)).toBe(false)
    }
  })
  it('prefixo parecido não vale (/inboxes, /settingsx)', () => {
    expect(isAppPath('/inboxes')).toBe(false)
    expect(isAppPath('/settingsx')).toBe(false)
  })
})
