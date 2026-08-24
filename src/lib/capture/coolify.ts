// ============================================================
// 🌐 Ativação AUTOMÁTICA de domínio próprio no proxy (Coolify API).
// Quando um capture_domain é verificado, adicionamos o domínio ao fqdn do
// app web no Coolify — o Traefik emite o certificado Let's Encrypt e passa
// a rotear o host pro CRM. As envs vêm do resource (gravadas via API +
// .env em 24/08): COOLIFY_API_URL, COOLIFY_API_TOKEN, COOLIFY_WEB_APP_UUID.
// Best-effort: sem envs ou com erro, o domínio fica verificado e a ativação
// sai manualmente (runbook: adicionar o domínio no app web do Coolify).
// ⚠️ O fqdn novo vira labels do container no PRÓXIMO recreate (nosso
// deploy-crm.sh) — a ativação completa acontece no deploy seguinte.
// ============================================================

interface CoolifyResult {
  ok: boolean
  detail: string
}

export async function addDomainToCoolify(domain: string): Promise<CoolifyResult> {
  const base = (process.env.COOLIFY_API_URL || '').replace(/\/$/, '')
  const token = process.env.COOLIFY_API_TOKEN || ''
  const uuid = process.env.COOLIFY_WEB_APP_UUID || ''
  if (!base || !token || !uuid) {
    return { ok: false, detail: 'Coolify API não configurada (envs ausentes).' }
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  const timeout = (ms: number) => {
    const c = new AbortController()
    setTimeout(() => c.abort(), ms)
    return c.signal
  }
  try {
    const cur = await fetch(`${base}/api/v1/applications/${uuid}`, {
      headers,
      signal: timeout(8000),
      cache: 'no-store',
    })
    if (!cur.ok) {
      return { ok: false, detail: `GET app falhou (${cur.status}).` }
    }
    const app = (await cur.json()) as { fqdn?: string | null }
    const fqdn = (app.fqdn ?? '').trim()
    const wanted = `https://${domain}`
    const list = fqdn
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (list.some((f) => f.replace(/^https?:\/\//, '').replace(/\/.*$/, '') === domain)) {
      return { ok: true, detail: 'Domínio já estava no proxy.' }
    }
    const next = [...list, wanted].join(',')
    const patch = await fetch(`${base}/api/v1/applications/${uuid}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ domains: next }),
      signal: timeout(8000),
    })
    if (!patch.ok) {
      const body = await patch.text().catch(() => '')
      return { ok: false, detail: `PATCH falhou (${patch.status}): ${body.slice(0, 200)}` }
    }
    return { ok: true, detail: 'Domínio adicionado ao proxy.' }
  } catch (err) {
    return { ok: false, detail: `Erro de rede: ${String(err).slice(0, 150)}` }
  }
}
