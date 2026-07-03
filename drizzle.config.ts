import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// DATABASE_URL lives in .env.local (Next.js convention); plain
// `dotenv/config` only reads .env, so load both explicitly.
loadEnv({ path: ['.env.local', '.env'] })

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})
