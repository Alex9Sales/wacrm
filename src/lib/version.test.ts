import { afterEach, describe, expect, it, vi } from 'vitest'

/** getBuildId cacheia no módulo — cada caso precisa de um import novo. */
async function freshGetBuildId() {
  vi.resetModules()
  const mod = await import('./version')
  return mod.getBuildId
}

const OLD = process.env.DEPLOYMENT_ID

afterEach(() => {
  if (OLD === undefined) delete process.env.DEPLOYMENT_ID
  else process.env.DEPLOYMENT_ID = OLD
})

describe('getBuildId', () => {
  it('usa o DEPLOYMENT_ID (SHA do commit) — é o único que muda a cada deploy', async () => {
    process.env.DEPLOYMENT_ID = 'ce51a1b14869cd8065d4cdecf24844b985fd1f9e'
    expect((await freshGetBuildId())()).toBe('ce51a1b14869cd8065d4cdecf24844b985fd1f9e')
  })

  it('ignora o sentinela "dev" do Dockerfile e cai no fallback', async () => {
    process.env.DEPLOYMENT_ID = 'dev'
    const id = (await freshGetBuildId())()
    expect(id).not.toBe('dev-sentinel-should-not-be-used')
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('sem DEPLOYMENT_ID não quebra (dev local)', async () => {
    delete process.env.DEPLOYMENT_ID
    expect(typeof (await freshGetBuildId())()).toBe('string')
  })
})
