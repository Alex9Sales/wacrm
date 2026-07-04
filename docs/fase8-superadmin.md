# Fase 8 — Painel Super-admin (operador SaaS da Fluxia)

Camada ACIMA das organizações: a Fluxia (agência) controla, provisiona e cobra os clientes.
Decisões do Alex: construir agora · Alex cria conta+senha do cliente e entrega (ele troca depois) · lembrete de cobrança via WhatsApp por canal da Fluxia.

## Conceito

- **Platform admin** = Alex/Fluxia — usuário ACIMA de todas as orgs. NÃO é papel de org (owner/admin/agent/viewer). Gate por **allowlist de e-mail via env** `PLATFORM_ADMIN_EMAILS` (seguro, sem UI pra conceder; Alex controla). Helper `isPlatformAdmin(session)`.
- Cada cliente = uma **organization** (modelo já existente). O super-admin adiciona metadados de billing + controle de status.

## Modelo de dados

### Tabela `organization_billing` (satélite 1:1 com organization)
```
organization_id uuid PK → organization(id) cascade
status text NOT NULL default 'active'  -- 'active' | 'suspended' | 'trial'
started_at timestamptz     -- data de entrada
due_at timestamptz         -- vencimento do pagamento
plan text                  -- rótulo do plano (opcional)
billing_phone text         -- telefone WhatsApp do cliente p/ lembrete (E.164)
notes text
last_reminder_at timestamptz
created_at / updated_at
```
Criada na org: no provisionamento e no signup (default 'active', started_at=now). Aplicar no dev E no **prod** (crmfluxia_prod está vazio, seguro).

## Gate de plataforma

- `src/lib/auth/platform.ts`: `isPlatformAdmin(userEmailOrSession): boolean` — checa contra `PLATFORM_ADMIN_EMAILS` (csv). `requirePlatformAdmin()` server-side (401/403).
- Middleware: proteger `/admin` e `/api/admin/*` — só passa com sessão cujo e-mail está na allowlist (checagem leve por cookie + verificação real no server via requirePlatformAdmin).

## Suspensão (enforcement)

- `getCurrentAccount` (chokepoint) carrega o billing.status da org ativa. Se `suspended` → lançar `AccountSuspendedError` (403). O app mostra tela "Conta suspensa — fale com a Fluxia". Platform admin não é afetado (ele opera pelo /admin).
- Login: se a única org do usuário está suspensa, mostrar aviso.

## Provisionamento (Alex cria a conta do cliente)

- `POST /api/admin/clients` (requirePlatformAdmin): body `{ orgName, ownerName, ownerEmail, password, plan?, dueAt?, billingPhone? }`.
  - Cria user (Better Auth `auth.api.signUpEmail` server-side — cria com senha) + organization + member owner + `organization_billing` (started_at=now, status active/trial, due_at, billing_phone).
  - Retorna as credenciais pra Alex entregar (login=email, senha inicial).
- Cliente loga → **troca a senha** (settings): reativar o form de senha via Better Auth `changePassword` (era stub da Fase 2). Idealmente forçar troca no 1º login (flag `must_change_password` — opcional v1).

## Telas /admin (só platform admin)

1. **Lista de clientes**: todas as orgs com dono (email), status (badge), started_at, due_at, plano, nº membros/canais. Ordenar por vencimento; destacar **vencidos**.
2. **Ligar/desligar** cliente (suspend/activate) — toggle de status.
3. **Editar billing**: started_at, due_at, plano, billing_phone, notes.
4. **Provisionar novo cliente**: form → cria org+owner+senha → mostra credenciais.
5. **Vencidos**: contador + lista dos que passaram do due_at.
6. **Enviar lembrete de cobrança** (WhatsApp): botão por cliente vencido → dispara mensagem pro billing_phone via **canal da Fluxia** (config: qual channel_id envia os lembretes — `PLATFORM_BILLING_CHANNEL_ID` env, ou a 1ª org do Alex). Usa o funil de envio existente (getProvider(channel).sendText). Marca last_reminder_at.

## APIs /api/admin/*

- GET /api/admin/clients (lista com billing + owner + counts)
- POST /api/admin/clients (provisionar)
- PATCH /api/admin/clients/[orgId] (status, dates, plan, billing_phone, notes)
- POST /api/admin/clients/[orgId]/reminder (dispara WhatsApp)
- GET /api/admin/overview (contadores: total, ativos, suspensos, vencidos)

## Extras pedidos

- **Olhinho de senha** (show/hide) nos forms de login, signup, reset-password, e no form de troca de senha.
- **Troca de senha** (settings) reativada via Better Auth `changePassword` (destrava o stub da Fase 2).

## Cron (opcional v1.1)

- Job diário que marca vencidos e (opcional) auto-dispara lembrete. Fora do caminho crítico; começar manual (botão).

## Verificação

- Provisionar cliente pelo /admin → login do cliente funciona → troca senha → OK.
- Suspender → cliente vê "conta suspensa"; reativar → volta.
- Vencido aparece na lista; botão de lembrete dispara WhatsApp (via canal Fluxia) e marca last_reminder_at.
- Platform admin (email na allowlist) acessa /admin; não-admin recebe 403.
- Aplicar schema no prod; deploy via CI (git push → GitHub Actions → Coolify pull).
