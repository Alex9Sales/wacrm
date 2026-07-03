import { describe, it, expect, vi } from 'vitest'

// decrypt is identity in tests so we don't depend on real ciphertext.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
}))

// Mock only the `db` client; keep the real table objects so `eq()` and
// column references in the module under test keep working.
const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(h.rows),
  }
  return {
    ...actual,
    db: { select: () => chain },
  }
})

import { loadAiConfig } from './config'

function dbReturning(row: Record<string, unknown> | null): void {
  h.rows = row ? [row] : []
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  apiKey: 'enc-key',
  systemPrompt: null,
  isActive: false,
  autoReplyEnabled: false,
  autoReplyMaxPerConversation: 3,
  embeddingsApiKey: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    dbReturning(ROW)
    expect(await loadAiConfig('acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    dbReturning(ROW)
    const config = await loadAiConfig('acct', { requireActive: false })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    dbReturning(null)
    expect(await loadAiConfig('acct', { requireActive: false })).toBeNull()
  })
})
