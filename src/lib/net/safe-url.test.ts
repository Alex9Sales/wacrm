import { describe, expect, it } from 'vitest'

import { assertPublicUrl, classifyUrl, isPrivateIp, restrictBase } from './safe-url'

describe('isPrivateIp', () => {
  it('reconhece faixas internas', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'])
      expect(isPrivateIp(ip), ip).toBe(true)
  })
  it('deixa IP público passar', () => {
    for (const ip of ['8.8.8.8', '72.60.137.234', '2606:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false)
  })
})

describe('classifyUrl (sem rede)', () => {
  it('bloqueia protocolo, porta, host interno e IP privado', () => {
    expect(classifyUrl('ftp://example.com/x').ok).toBe(false)
    expect(classifyUrl('http://example.com:9000/media/').ok).toBe(false)
    expect(classifyUrl('http://minio-usncons4u3ag50maylh9edtc:9000/media/').ok).toBe(false)
    expect(classifyUrl('http://localhost/api').ok).toBe(false)
    expect(classifyUrl('http://127.0.0.1/').ok).toBe(false)
    expect(classifyUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false)
    expect(classifyUrl('http://[::1]/').ok).toBe(false)
    expect(classifyUrl('http://api.internal/').ok).toBe(false)
    expect(classifyUrl('https://user:pass@example.com/').ok).toBe(false)
  })
  it('deixa https público na 443 e http na 80', () => {
    expect(classifyUrl('https://xyz.supabase.co/rest/v1/rpc/x').ok).toBe(true)
    expect(classifyUrl('http://example.com/').ok).toBe(true)
    expect(classifyUrl('https://example.com:443/').ok).toBe(true)
  })
})

describe('assertPublicUrl (DNS)', () => {
  it('localhost e IP privado literal são barrados antes do DNS', async () => {
    await expect(assertPublicUrl('http://localhost:80/')).rejects.toThrow(/bloqueada/)
    await expect(assertPublicUrl('http://10.0.0.5/')).rejects.toThrow(/bloqueada/)
  })
  it('IP público literal passa sem DNS', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeInstanceOf(URL)
  })
})

describe('restrictBase', () => {
  it('só aceita sobrescrita no host oficial', () => {
    expect(restrictBase('https://graph.facebook.com/v22.0', 'https://graph.facebook.com/v21.0', ['graph.facebook.com'])).toBe('https://graph.facebook.com/v22.0')
    expect(restrictBase('https://evil.example.com/graph', 'https://graph.facebook.com/v21.0', ['graph.facebook.com'])).toBe('https://graph.facebook.com/v21.0')
    expect(restrictBase('http://graph.facebook.com/', 'https://graph.facebook.com/v21.0', ['graph.facebook.com'])).toBe('https://graph.facebook.com/v21.0')
    expect(restrictBase(undefined, 'x', ['a'])).toBe('x')
  })
})
