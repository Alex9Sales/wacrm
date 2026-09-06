// npx tsx src/scripts/indexnow-ping.ts   → avisa o IndexNow de TODAS as páginas públicas.
import { pingIndexNow } from '@/lib/seo/indexnow'
import { PUBLIC_PAGES } from '@/lib/seo/site'

pingIndexNow(PUBLIC_PAGES.map((p) => p.path))
  .then((r) => {
    console.log(`IndexNow: ${r.ok ? 'ok' : 'falhou'} (HTTP ${r.status}) — ${PUBLIC_PAGES.length} URLs`)
    process.exit(r.ok ? 0 : 1)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
