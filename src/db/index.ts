import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'
import * as relations from './relations'

// Lazy, shared Drizzle client over a node-postgres Pool.
// Mirrors the lazy-singleton convention of src/lib/flows/admin-client.ts —
// nothing connects at import time, and a missing DATABASE_URL fails loudly
// at first use instead of producing cryptic pool errors.
const fullSchema = { ...schema, ...relations }

let _db: NodePgDatabase<typeof fullSchema> | null = null

export function getDb(): NodePgDatabase<typeof fullSchema> {
  if (!_db) {
    const url = process.env.DATABASE_URL
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. Add it to .env.local (postgres://user:pass@host:port/db).',
      )
    }
    _db = drizzle(new Pool({ connectionString: url }), { schema: fullSchema })
  }
  return _db
}

// Convenience proxy so call sites can `import { db } from '@/db'` and use it
// directly; initialization still happens lazily on first property access.
export const db: NodePgDatabase<typeof fullSchema> = new Proxy(
  {} as NodePgDatabase<typeof fullSchema>,
  {
    get(_target, prop, receiver) {
      const real = getDb() as unknown as Record<string | symbol, unknown>
      const value = Reflect.get(real, prop, receiver)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value
    },
  },
)

export * from './schema'
