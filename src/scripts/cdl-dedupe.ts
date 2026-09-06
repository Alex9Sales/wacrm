// ============================================================
// 📊 Junta as vendas em dobro do histórico (planilha × ERP × Ganho) e
// recalcula as métricas. Uma vez por conta; idempotente.
//
//   npx tsx src/scripts/cdl-dedupe.ts --account all
//   npx tsx src/scripts/cdl-dedupe.ts --account <uuid> [--dry]
//   npx tsx src/scripts/cdl-dedupe.ts --account <uuid> --recompute   (só recalcula as métricas)
//
// Nada é apagado: a linha repetida vira status='merged' apontando para a que
// ficou (metadata.merged_into). Regra em lib/cdl/same-sale.ts.
// ============================================================

import { eq, sql } from 'drizzle-orm'

import { db, organization } from '@/db'
import { cleanupAccountDuplicates } from '@/lib/cdl/merge'
import { recomputeAccountMetrics, recomputeMetricsForContacts } from '@/lib/cdl/metrics'

async function main() {
  const argv = process.argv.slice(2)
  const idx = argv.indexOf('--account')
  const target = idx >= 0 ? argv[idx + 1] : ''
  const dry = argv.includes('--dry')
  // --recompute: recalcula as métricas de TODOS os contatos da conta (depois de uma limpeza grande).
  const recomputeAll = argv.includes('--recompute')
  if (!target) {
    console.error('uso: --account all|<uuid> [--dry]')
    process.exit(2)
  }
  const accounts =
    target === 'all'
      ? await db.select({ id: organization.id, name: organization.name }).from(organization)
      : await db.select({ id: organization.id, name: organization.name }).from(organization).where(eq(organization.id, target))

  for (const a of accounts) {
    if (dry) {
      const r = await db.execute(sql`
        SELECT count(DISTINCT a.contact_id)::int AS contatos, count(*)::int AS pares
        FROM customer_transactions a
        JOIN customer_transactions b
          ON b.account_id = a.account_id AND b.contact_id = a.contact_id AND b.id <> a.id
         AND b.source <> a.source
         AND abs(extract(epoch FROM (b.occurred_at - a.occurred_at))) <= 36 * 3600
         AND (b.amount = a.amount OR a.source = 'deal' OR b.source = 'deal')
        WHERE a.account_id = ${a.id}::uuid
          AND a.status NOT IN ('canceled','merged') AND b.status NOT IN ('canceled','merged')`)
      const row = r.rows[0] as { contatos: number; pares: number }
      console.log(`[dry] ${a.name}: ${row.contatos} contatos com possível dobro (${row.pares} pares)`)
      continue
    }
    const started = Date.now()
    if (recomputeAll) {
      await recomputeAccountMetrics(a.id)
      console.log(`${a.name}: métricas recalculadas para a conta inteira · ${Math.round((Date.now() - started) / 1000)}s`)
      continue
    }
    const r = await cleanupAccountDuplicates(a.id)
    if (r.contactIds.length) {
      // Em lotes: recomputeMetricsForContacts vira ARRAY[...] com um parâmetro por id.
      for (let i = 0; i < r.contactIds.length; i += 200) {
        await recomputeMetricsForContacts(a.id, r.contactIds.slice(i, i + 200))
      }
    }
    console.log(
      `${a.name}: ${r.contactsChecked} contatos checados · ${r.contactsChanged} alterados · ${r.merged} linhas fundidas · ${Math.round((Date.now() - started) / 1000)}s`,
    )
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
