---
name: fluxia-suporte-bug
description: >-
  Resolve um chamado de suporte / bug do CRMFLUXIA (FluxiaCRM) de ponta a ponta:
  entende o problema a partir do brief + print, acha a causa no código, corrige,
  roda typecheck+build, e MOSTRA o diff com explicação — PARANDO antes de subir.
  O deploy em produção só acontece com um OK explícito ("pode subir"). Use quando
  o Alex ou o Hermes pedir para resolver um bug reportado no setor de Suporte
  (o "Copiar p/ IA" do /admin/suporte gera o brief), ou colar um erro/print.
---

# Resolver bug do Fluxia (suporte)

Você vai resolver um problema reportado por um cliente do **CRMFLUXIA** (o CRM de
WhatsApp "FluxiaCRM / SalesTecnologia", `crm.salestecnologia.com.br`). O tom com o
solicitante (Alex/Hermes) é **pt-BR**, direto.

**Regra de ouro (decisão do Alex): NUNCA faça deploy em produção sem um OK
explícito.** Tem clientes reais no ar. Você vai até "corrigir + build + mostrar o
diff e a explicação" e PARA. Só quando o operador disser "pode subir" / "deploy"
você executa o deploy.

## Entrada

Você recebe um dos dois:
1. **Um brief** (o botão "Copiar p/ IA" em `/admin/suporte` monta assim):
   ```
   Tipo, Cliente, Aberto por, Assunto, Descrição, Tela (URL), Navegador,
   Prints (URLs), ticket_id
   ```
2. Ou um **erro/print solto** que o Alex colou.

Se vier `ticket_id` e você tiver acesso ao banco, pode puxar o chamado completo
(ver "Puxar chamado pelo id"). Mas o brief normalmente já basta.

## Passo a passo

### 1. Entender o problema
- Leia o **Assunto + Descrição**. Abra as **URLs dos prints** (é a imagem do erro
  que o cliente viu) para ler a mensagem de erro exata.
- Pela **Tela (URL)** identifique a rota/página (ex.: `/inbox`, `/pipelines/[id]`,
  `/agents`). Isso aponta o arquivo em `src/app/...`.
- Resuma em 1-2 frases: *o que o cliente esperava × o que aconteceu*.

### 2. Achar a causa no código
- Mapeie sintoma → código: rota em `src/app`, UI em `src/components`, lógica em
  `src/lib`, dados em `src/db/schema.ts`.
- Use busca (Grep/Glob) pela mensagem de erro, nome de componente, rota ou função.
- **Leia antes de editar.** Confirme a causa real — não chute. Se for erro de
  runtime no navegador, procure o handler/efeito; se for de servidor, a rota/action.

### 3. Regras do projeto (IMPORTANTE — leia AGENTS.md)
- Este é um **Next.js 16 MODIFICADO** (breaking changes vs. o que você conhece).
  Antes de escrever qualquer código de Next, leia o guia relevante em
  `node_modules/next/dist/docs/`. Respeite avisos de depreciação.
- UI é **Base UI (`@base-ui/react`), NÃO Radix**. `DropdownMenuLabel` exige
  `<DropdownMenuGroup>` em volta (senão "MenuGroupContext is missing").
- ORM = **Drizzle** + node-postgres. Gotcha de array: NÃO interpole array JS com
  `::tipo[]`; use `ARRAY[...]` com `sql.join`.
- Escreva código que **pareça** o código ao redor (mesma nomenclatura, densidade
  de comentários, idioma dos comentários).

### 4. Corrigir
- Mudança **mínima** e localizada. Não refatore de brinde.
- **Se precisar de migração de banco:** crie `drizzle/00NN_nome.sql` (próximo
  número), atualize `src/db/schema.ts`, e aplique nos **DOIS bancos** (ver
  "Bancos"). Um desalinhamento dev×prod já quebrou produção uma vez.

### 5. Verificar (sempre)
- `npm run typecheck`
- `npm run build`
- Se tocou algo com teste, rode o vitest do arquivo: `npx vitest run <arquivo>`.
- **macOS não tem `timeout`** — NÃO embrulhe build/tsc com `timeout` (sai 127 =
  falso "ok"). Rode direto ou em background.
- **Não dá pra rodar o dev server localmente** (o banco é firewalled). A validação
  é typecheck + build (+ testes). A verificação visual real é o Alex no print, ou
  depois do deploy.

### 6. Mostrar e PARAR
- Mostre o **diff** (`git diff`) e uma **explicação em pt-BR**: qual era a causa,
  o que você mudou e por quê, e (se houver) qual migração precisa subir.
- **Pare aqui.** Pergunte se pode subir. NÃO faça deploy sem o "pode subir".

### 7. Deploy — SÓ com OK explícito
Quando o operador aprovar ("pode subir"/"deploy"):
1. `git` na branch **`fluxia/core`** (é a branch de trabalho; não precisa PR pra
   deployar). Commit em pt-BR + trailer `Co-Authored-By: Claude ...`.
2. `git push origin fluxia/core`.
3. Espere o **GitHub Actions terminar o passo "Build and push"** com sucesso
   (`gh run view <id> --json jobs`). ⚠️ O passo **"Deploy via SSH" é cronicamente
   instável** — o run inteiro pode marcar `failure` só por causa dele; **ignore**,
   o que importa é "Build and push" = success (imagem já foi pro GHCR).
4. Deploy manual confiável:
   ```bash
   ssh root@72.60.137.234 'nohup bash /root/deploy-crm.sh > /root/deploy-manual.log 2>&1 & echo pid $!'
   ```
   Faça poll de `tail /root/deploy-manual.log` até aparecer **`[deploy] OK`**.
5. Confirme os containers saudáveis:
   ```bash
   ssh root@72.60.137.234 "docker ps --format '{{.Names}}\t{{.Status}}' | grep -iE 'klqgmh23eh0mi72r6scqtdo2|i9edhxtdkqf5gi8b12zh2j0h'"
   ```
   (`klqgmh...` = web, `i9edhxt...` = worker; ambos devem estar `healthy`.)
6. Avise o Alex que subiu e que ele pode dar **Cmd+Shift+R** (o bundle velho
   "congela" a aba após deploy — JS antigo chama Server Action com hash mudado).

### 8. Fechar o chamado
- Se houver `ticket_id`, marque como resolvido. Pela UI (platform admin) é
  `PATCH /api/admin/support/{id}` `{status:'resolved'}`. Direto no banco (prod):
  ```bash
  ssh root@72.60.137.234 "docker exec postgres-usncons4u3ag50maylh9edtc psql -U crmfluxia -d crmfluxia_prod -c \"UPDATE support_tickets SET status='resolved', updated_at=now() WHERE id='<ticket_id>';\""
  ```
- **Salve o aprendizado no brain** (memória) se descobriu algo não óbvio — a causa
  real, um gotcha, um furo de onboarding. Siga o padrão de memória do projeto.

## Bancos (dois — aplicar migração nos DOIS)
- dev = `crmfluxia`, prod = `crmfluxia_prod`, no container postgres do VPS.
- Aplicar um `.sql`:
  ```bash
  ssh root@72.60.137.234 "docker exec -i postgres-usncons4u3ag50maylh9edtc psql -U crmfluxia -d crmfluxia -v ON_ERROR_STOP=1" < drizzle/00NN_x.sql
  ssh root@72.60.137.234 "docker exec -i postgres-usncons4u3ag50maylh9edtc psql -U crmfluxia -d crmfluxia_prod -v ON_ERROR_STOP=1" < drizzle/00NN_x.sql
  ```

## Puxar chamado pelo id (opcional)
```bash
ssh root@72.60.137.234 "docker exec postgres-usncons4u3ag50maylh9edtc psql -U crmfluxia -d crmfluxia_prod -x -c \"SELECT id,type,subject,description,screenshot_urls,context,status FROM support_tickets WHERE id='<ticket_id>';\""
```

## Não faça
- ❌ Deploy sem OK explícito.
- ❌ Migração em só um banco.
- ❌ Rodar dev server local (não conecta no banco).
- ❌ Refatoração ampla "de brinde" num fix de suporte.
- ❌ `timeout` embrulhando build/tsc no macOS.
