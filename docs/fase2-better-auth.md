# Fase 2 — Better Auth + organizations (design + contrato)

Fonte de verdade da migração de auth. Better Auth **1.6.23**. Decisões fechadas:
organization = tenant · só e-mail/senha · e-mail transacional logado no console em dev.

## Modelo de tenancy (alvo)

Better Auth é dono das suas próprias tabelas; **tenancy = `organization`**.
- **DROP** as tabelas de domínio `accounts` e `profiles`.
- `account_id` (uuid) em ~22 tabelas de domínio passa a **FK → `organization.id`** (mesmo nome de coluna, novo alvo). `organization.id` é **uuid** (ver `generateId`).
- `owner_user_id` (era em accounts) → o dono é o `member` com role `owner`.
- `default_currency` (era em accounts) → **additionalField `defaultCurrency`** em `organization`.
- Identidade do usuário: `user.name` (=full_name), `user.email`, `user.image` (=avatar_url).
- Membership + papel: tabela `member` (`organizationId`, `userId`, `role` text).
- `beta_features`: **descontinuado** (sem writers/gates ativos); leitores default `[]`.
- `account_role_enum`: removido do schema (Better Auth guarda role como **text**).

### Tabelas do Better Auth (id uuid)
`user`, `session` (tem `activeOrganizationId`), `account` (OAuth/senha — NÃO confundir com
o antigo domínio accounts), `verification`, `organization` (+`defaultCurrency`), `member`, `invitation`.

## Config (arquivos novos)

- `src/lib/auth.ts` — `betterAuth({ database: drizzleAdapter(db,{provider:'pg',schema}),
  advanced:{database:{generateId:'uuid'}}, emailAndPassword:{enabled:true,
  requireEmailVerification:false /*dev*/, sendResetPassword: consoleEmail},
  emailVerification:{sendVerificationEmail: consoleEmail},
  plugins:[organization({ ac, roles:{owner,admin,agent,viewer}, creatorRole:'owner',
  schema:{organization:{additionalFields:{defaultCurrency:{type:'string',input:true,
  required:false,fieldName:'default_currency'}}}}, sendInvitationEmail: consoleEmail })],
  databaseHooks:{ session:{ create:{ before: setActiveOrgToFirstMembership }}}})`.
  `consoleEmail` = helper `src/lib/auth/email.ts` que `console.log` do link em dev
  (`// TODO(email): plugar Resend/SMTP`).
- `src/lib/permissions.ts` — `createAccessControl` + roles owner/admin/agent/viewer
  (import `better-auth/plugins/access` e `better-auth/plugins/organization/access`).
- `src/lib/auth-client.ts` — `createAuthClient` (`better-auth/react`) + `organizationClient`.
- `src/app/api/auth/[...all]/route.ts` — `toNextJsHandler(auth)` (`better-auth/next-js`).

## Contrato dos chokepoints (NÃO mudar as assinaturas — consumidores dependem)

- `getSessionUserId(): Promise<string|null>` (session.ts) → `auth.api.getSession({headers:await headers()})` → `session?.user.id`.
- `getCurrentAccount(): Promise<AccountContext>` (account.ts) — MANTÉM o shape
  `{ userId, accountId, role, account:{id,name} }` (+ `defaultCurrency?` opcional). Resolve:
  userId da sessão; accountId = `session.session.activeOrganizationId`; role via
  `auth.api.getActiveMember({headers})` → `member.role` (validar com `isAccountRole`);
  account = query em `organization` (id,name,defaultCurrency). Sem sessão → `UnauthorizedError`;
  sem org ativa/membership → `ForbiddenError`. `requireRole(min)` inalterado (usa `hasMinRole`).
- `requireApiKey` (api-context.ts) — **inalterado** (api keys independem de sessão; `accountId` é do row da key = organization.id).
- `roles.ts` — inalterado (roleRank owner4/admin3/agent2/viewer1; valores batem com member.role text).
- `GET /api/me` — MANTÉM shape `{ profile:{id,full_name,email,avatar_url,role,beta_features,
  account_id,account_role}, account:{id,name,default_currency} }`. Monta de user+member+organization
  (`profile.id`=user.id; beta_features=[]; role='user').
- `use-auth.tsx` — segue hidratando via `/api/me`; `signOut` passa a chamar `authClient.signOut()` e redirecionar.
- `middleware.ts` — protege rotas de dashboard/API via presença do cookie de sessão do
  Better Auth (checagem leve; `getSessionCookie` do `better-auth/cookies` ou fetch a /api/me).
  Mantém redirect de /login,/signup quando já logado.

## Signup / login (páginas)

- signup: `authClient.signUp.email({name,email,password})` → depois
  `authClient.organization.create({name:<nome da empresa>, slug})` (creator vira member owner
  automático) → `organization.setActive`. Redirect /dashboard.
- login: `authClient.signIn.email({email,password})` → hook de sessão seta org ativa → /dashboard.
- forgot-password: `authClient.requestPasswordReset({email,redirectTo:'/reset-password'})`;
  página `/reset-password` chama `authClient.resetPassword({newPassword,token})`.
- join/[token]: `authClient.organization.getInvitation({query:{id}})` p/ peek →
  se logado `acceptInvitation({invitationId})`; senão signup/login primeiro. (token = invitation.id)

## 6 rotas 501 → reativar sobre Better Auth org API

- `account/members` (GET) → `member ⋈ user` da org ativa.
- `account/members/[userId]` PATCH(role)/DELETE → `auth.api.updateMemberRole`/`removeMember`.
- `account/transfer-ownership` POST → `auth.api.updateMemberRole` (owner→novo) — usar a op de transfer do plugin se houver; senão promover novo a owner + rebaixar atual.
- `account/invitations` GET(list)/POST(create) → `auth.api.listInvitations`/`createInvitation`.
- `account/invitations/[id]` DELETE → `auth.api.cancelInvitation`.
- `invitations/[token]/peek` GET → `auth.api.getInvitation` (público).
- `invitations/[token]/redeem` POST → `auth.api.acceptInvitation`.
- Guardas de role: manter via `requireRole('admin')` etc. onde aplicável.

## Seed dev (scripts/seed-dev.ts)

Recriar via Better Auth: criar user (com senha hasheada — usar `auth.api.signUpEmail` ou inserir
user+account(password) direto), organization "Fluxia Dev" (uuid fixo), member owner, e o resto
do domínio (contatos/pipeline/conversas) FK → organization.id. Imprimir `DEV_SEED_USER_ID`.
Stub de sessão dev (`DEV_AUTH_ALLOW`) pode ser aposentado — mas manter até o login por cookie
estar validado end-to-end.

## Verificação da fundação (antes de fanar Step C)

1. `drizzle-kit`/psql aplica o baseline novo (com tabelas Better Auth, sem accounts/profiles).
2. App builda; `/api/auth/*` responde.
3. Signup real cria user+org+member; login seta cookie; `/api/me` retorna a org.
4. `getCurrentAccount` resolve role da org ativa.
5. tsc 0 + suíte verde.
