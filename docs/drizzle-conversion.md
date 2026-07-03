# Guia de conversão Supabase → Drizzle (Fase 1)

Padrão único para converter chamadas do Supabase query-builder para Drizzle.
Referência viva durante a Fase 1; apagar quando a conversão terminar.

## Imports

```ts
import { db, contacts, conversations /* tabelas */ } from "@/db";
import { firstOrNull, firstOrThrow } from "@/db/helpers";
import { eq, and, or, desc, asc, ilike, inArray, sql, count, isNull, gte, lte } from "drizzle-orm";
```

- NUNCA importar `@/lib/supabase/*` nem `@/lib/flows/admin-client` em código convertido.
- O client é único (`db`) — não existe mais distinção anon/service-role. TODA query
  de dado de tenant DEVE filtrar por `accountId` explicitamente (não há RLS).

## Equivalências

| Supabase | Drizzle |
|---|---|
| `.from('x').select('a, b').eq('c', v)` | `db.select({ a: x.a, b: x.b }).from(x).where(eq(x.c, v))` |
| `.select('*')` | `db.select().from(x)` |
| `.maybeSingle()` | `firstOrNull(await ….limit(1))` |
| `.single()` | `firstOrThrow(await ….limit(1))` |
| `.insert(row).select().single()` | `firstOrThrow(await db.insert(x).values(row).returning())` |
| `.update(patch).eq(...)` | `db.update(x).set(patch).where(...)` |
| `.upsert(row, { onConflict: 'col' })` | `db.insert(x).values(row).onConflictDoUpdate({ target: x.col, set: {...} })` |
| `.delete().eq(...)` | `db.delete(x).where(...)` |
| `.select('*', { count: 'exact', head: true })` | `firstOrThrow(await db.select({ n: count() }).from(x).where(...))` |
| `.order('col', { ascending: false })` | `.orderBy(desc(x.col))` |
| `.range(from, to)` | `.limit(to - from + 1).offset(from)` |
| `.in('col', arr)` | `inArray(x.col, arr)` |
| `.ilike('col', pat)` | `ilike(x.col, pat)` |
| `.rpc('fn', { args })` | `await db.execute(sql\`SELECT fn(${a}, ${b})\`)` (funções mantidas no baseline) |
| embed `a:tabela(...)` (join PostgREST) | `leftJoin`/`innerJoin` explícito ou duas queries |

## Semântica de erro

- Supabase retorna `{ data, error }`; Drizzle **lança**. Onde o código antigo fazia
  `if (error) { … }`, envolver em `try/catch` SÓ se o fluxo tratava o erro de forma
  específica; caso contrário deixar propagar (rotas já têm catch → `toErrorResponse`).
- `.maybeSingle()` que retornava `null` sem erro → `firstOrNull` (não lança).

## Nomes de campo

- O schema Drizzle usa camelCase nas propriedades TS (`accountId`) mapeando snake_case
  no banco (`account_id`). Os tipos de `src/types/*` continuam snake_case (vieram da
  API pública) — ao retornar JSON de rota, manter o shape antigo (renomear no select:
  `db.select({ account_id: x.accountId, … })` quando o shape da resposta importar).

## Contextos de auth

- Rotas de dashboard: `const ctx = await requireRole('agent')` — `ctx` NÃO tem mais
  `.supabase`; importar `db` diretamente. `ctx.userId/accountId/role` inalterados.
- Rotas /api/v1: `requireApiKey(request, scope)` — idem, sem `.supabase`.
- Sessão em dev (até Better Auth na Fase 2): `DEV_SEED_USER_ID` no .env.local
  (ver `scripts/seed-dev.ts`).

## RPCs com assinatura alterada

- `filter_contacts_by_tags(p_account_id, …)` — ganhou parâmetro de account (RLS morreu).
- `notify_conversation_assigned` — não conhece mais o ator; suprimir autonotificação no app.

## Realtime / Storage (NÃO converter nesta fase)

- `supabase.channel(...)` (hooks de realtime) e `supabase.storage` ficam para a Fase 3
  (SSE + MinIO). Se um arquivo do seu lote usar isso, converta só a parte de dados e
  deixe um `// TODO(fase-3):` no restante — mas o arquivo precisa compilar.

## Componentes client (leva final)

Componentes `"use client"` NÃO podem importar `@/db` (o driver `pg` é Node-only).
Regras:
- **Contexto de auth**: usar `useAuth()` (já reescrito pra buscar `/api/me`). Nunca
  `createClient()` do supabase.
- **Leituras/mutações de dados que usavam `supabase.from()` no browser**: trocar por
  (a) `fetch` numa rota de API já existente, ou (b) uma **server action** colocada
  (`"use server"`, com `getCurrentAccount()` + Drizzle scoped por account). Preferir
  reusar rota existente; criar action só quando não houver rota.
- **Realtime** (`supabase.channel(...)`, `.on('postgres_changes'|'presence'|'broadcast')`):
  fica pra Fase 3 (SSE). Nesta fase, **neutralizar**: remover a subscription e deixar
  o dado carregar por fetch inicial + refetch manual/on-focus. Marcar `// TODO(fase-3): realtime via SSE`.
  Hooks afetados: use-realtime, use-presence, use-total-unread, use-unread-notifications.
- **Auth (`supabase.auth.*`)**: login/signup/reset/signOut → Fase 2 (Better Auth).
  Páginas de auth viram placeholders que redirecionam/avisam; `signOut` do use-auth já
  é stub. Não reimplementar auth agora.
- **Storage (`supabase.storage`)**: upload de avatar/mídia → Fase 3 (MinIO). Deixar
  `// TODO(fase-3)` e desabilitar o controle de upload (ou 501 na rota).
- Manter shapes de dados (snake_case) idênticos aos que os componentes já esperam.
