// ============================================================
// 📡 IndexNow — avisa Bing (e quem participa do protocolo) que URLs mudaram.
// A chave fica em /public/<chave>.txt (o buscador confere que somos nós).
// ============================================================

import { absoluteUrl, SITE_URL } from './site'

export const INDEXNOW_KEY = '3523cdd869970f16caff655bf7400c72'

export async function pingIndexNow(paths: string[]): Promise<{ ok: boolean; status: number }> {
  const res = await fetch('https://api.indexnow.org/IndexNow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE_URL).host,
      key: INDEXNOW_KEY,
      keyLocation: absoluteUrl(`/${INDEXNOW_KEY}.txt`),
      urlList: paths.map(absoluteUrl),
    }),
  })
  return { ok: res.ok, status: res.status }
}
