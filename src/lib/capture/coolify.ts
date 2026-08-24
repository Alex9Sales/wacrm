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
  /** true quando o fqdn foi de fato ALTERADO (dispara o deploy). */
  changed?: boolean
}

function coolifyEnv() {
  const base = (process.env.COOLIFY_API_URL || '').replace(/\/$/, '')
  const token = process.env.COOLIFY_API_TOKEN || ''
  const uuid = process.env.COOLIFY_WEB_APP_UUID || ''
  if (!base || !token || !uuid) return null
  return {
    base,
    uuid,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  }
}

function timeout(ms: number): AbortSignal {
  const c = new AbortController()
  setTimeout(() => c.abort(), ms)
  return c.signal
}

/** fqdn atual do app como lista ('https://a.com', ...). null em erro. */
async function getFqdnList(
  env: NonNullable<ReturnType<typeof coolifyEnv>>,
): Promise<string[] | null> {
  const cur = await fetch(`${env.base}/api/v1/applications/${env.uuid}`, {
    headers: env.headers,
    signal: timeout(8000),
    cache: 'no-store',
  })
  if (!cur.ok) return null
  const app = (await cur.json()) as { fqdn?: string | null }
  return (app.fqdn ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function patchFqdn(
  env: NonNullable<ReturnType<typeof coolifyEnv>>,
  list: string[],
): Promise<CoolifyResult> {
  const patch = await fetch(`${env.base}/api/v1/applications/${env.uuid}`, {
    method: 'PATCH',
    headers: env.headers,
    body: JSON.stringify({ domains: list.join(',') }),
    signal: timeout(8000),
  })
  if (!patch.ok) {
    const body = await patch.text().catch(() => '')
    return { ok: false, detail: `PATCH falhou (${patch.status}): ${body.slice(0, 200)}` }
  }
  return { ok: true, detail: 'fqdn atualizado.', changed: true }
}

const hostOf = (f: string) => f.replace(/^https?:\/\//, '').replace(/\/.*$/, '')

export async function addDomainToCoolify(domain: string): Promise<CoolifyResult> {
  const env = coolifyEnv()
  if (!env) return { ok: false, detail: 'Coolify API não configurada (envs ausentes).' }
  try {
    const list = await getFqdnList(env)
    if (!list) return { ok: false, detail: 'GET app falhou.' }
    if (list.some((f) => hostOf(f) === domain)) {
      return { ok: true, detail: 'Domínio já estava no proxy.', changed: false }
    }
    return await patchFqdn(env, [...list, `https://${domain}`])
  } catch (err) {
    return { ok: false, detail: `Erro de rede: ${String(err).slice(0, 150)}` }
  }
}

/** Tira o domínio do proxy (chamado ao remover o domínio na UI). Best-effort. */
export async function removeDomainFromCoolify(domain: string): Promise<CoolifyResult> {
  const env = coolifyEnv()
  if (!env) return { ok: false, detail: 'Coolify API não configurada (envs ausentes).' }
  try {
    const list = await getFqdnList(env)
    if (!list) return { ok: false, detail: 'GET app falhou.' }
    const next = list.filter((f) => hostOf(f) !== domain)
    if (next.length === list.length) {
      return { ok: true, detail: 'Domínio não estava no proxy.', changed: false }
    }
    return await patchFqdn(env, next)
  } catch (err) {
    return { ok: false, detail: `Erro de rede: ${String(err).slice(0, 150)}` }
  }
}

/**
 * Dispara o deploy do app web VIA Coolify — é ele que regenera o compose com
 * as labels novas do Traefik (o deploy manual por script NÃO regenera) e faz
 * o certificado Let's Encrypt ser emitido. A chamada só ENFILEIRA (retorna na
 * hora); o recreate acontece async no Coolify (~30-60s, downtime de segundos).
 */
export async function triggerCoolifyDeploy(): Promise<CoolifyResult> {
  const env = coolifyEnv()
  if (!env) return { ok: false, detail: 'Coolify API não configurada (envs ausentes).' }
  try {
    const r = await fetch(`${env.base}/api/v1/deploy?uuid=${env.uuid}`, {
      method: 'POST',
      headers: env.headers,
      signal: timeout(8000),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      return { ok: false, detail: `deploy falhou (${r.status}): ${body.slice(0, 200)}` }
    }
    return { ok: true, detail: 'Deploy enfileirado no Coolify.' }
  } catch (err) {
    return { ok: false, detail: `Erro de rede: ${String(err).slice(0, 150)}` }
  }
}
