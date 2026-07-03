# Fase 4 — Multi-canal (Meta + WAHA + Evolution + EvoGo)

Contrato de design + cheat-sheet dos providers (extraído dos adapters do RecebIA, testados em produção). Decisões: **uma conversa por (contato, canal)** · WAHA dedicado do CRM pra teste (porta 3010) · Evolution/EvoGo prontos no código, endpoint configurável depois.

## Modelo de dados

### Tabela `channels` (substitui `whatsapp_config`)
```
id uuid pk
account_id uuid → organization(id) cascade
provider text  -- 'meta' | 'waha' | 'evolution' | 'evogo'
name text      -- rótulo ("Comercial", "Suporte")
status text default 'disconnected'  -- disconnected|qr_pending|connected|error
phone_number text            -- E.164 quando conhecido
credentials text not null    -- JSON cifrado AES-256-GCM (encryption.ts) — chaves/tokens/session
provider_meta jsonb default '{}'  -- meta: {phone_number_id, waba_id}; waha/evo: {session|instance, baseUrl}
settings jsonb default '{}'  -- {throughputPerMin, jitterMs:[min,max]}
webhook_secret text not null -- token por canal p/ validar webhooks não-Meta
created_at / updated_at
UNIQUE(account_id, name)
-- índice único parcial p/ roteamento Meta:
CREATE UNIQUE INDEX channels_meta_pnid ON channels ((provider_meta->>'phone_number_id')) WHERE provider='meta';
```
`credentials` cifra um JSON por provider:
- meta: `{ accessToken, verifyToken }`
- waha: `{ apiKey }` (baseUrl vai em provider_meta)
- evolution: `{ apiKey }` (instance+baseUrl em provider_meta)
- evogo: `{ token }` (baseUrl em provider_meta)

### `conversations.channel_id`
`channel_id uuid → channels(id)`. **Uma conversa por (account_id, contact_id, channel_id)** — o inbound resolve/cria conversa por canal. Badge do canal no inbox.

### `message_templates.channel_id`
Templates só existem no Meta → `channel_id` FK (nullable durante migração; templates novos ligam a um canal meta).

Drop `whatsapp_config` (sem dados de prod; reseed).

## Interface do provider (`src/lib/channels/provider.ts`)
```ts
type ProviderId = 'meta'|'waha'|'evolution'|'evogo';
interface Capabilities {
  templates: boolean;        // só meta
  session24hWindow: boolean; // só meta
  interactive: boolean;      // só meta
  reactions: boolean;
  qrPairing: boolean;        // waha/evolution/evogo
  inboundMedia: boolean;     // false no EVOGO (não entrega base64 nem tem fetch)
  needsChatIdResolve: boolean; // waha (check-exists p/ 9º dígito)
  needsJitter: boolean;      // não-oficiais (anti-ban)
}
interface NormalizedInbound {
  externalMessageId: string;
  fromPhoneE164: string;     // já normalizado (55+DDD+num)
  fromMe: boolean;
  pushName?: string;
  contentType: 'text'|'image'|'audio'|'video'|'document'|'location'|'interactive';
  contentText?: string|null;
  media?: { kind:string; mimetype?:string; base64?:string; url?:string; filename?:string; fetchKey?:unknown };
  interactiveReplyId?: string;
  replyToExternalId?: string;
}
interface NormalizedStatus { externalMessageId: string; level: 2|3; } // 2=delivered,3=read
interface WhatsAppProvider {
  id: ProviderId; capabilities: Capabilities;
  sendText(ch, toE164, text, opts?): Promise<{externalMessageId:string}>;
  sendMedia(ch, toE164, media): Promise<{externalMessageId:string}>;
  sendTemplate?(ch, toE164, tpl): Promise<{externalMessageId:string}>;
  sendInteractive?(ch, toE164, i): Promise<{externalMessageId:string}>;
  sendReaction?(ch, targetExternalId, emoji): Promise<void>;
  verifyWebhook(req, ch|null): Promise<boolean>;  // meta: HMAC; outros: webhook_secret
  parseWebhook(body): { messages: NormalizedInbound[]; statuses: NormalizedStatus[] };
  fetchInboundMedia?(ch, fetchKey): Promise<{base64:string; mimetype:string}|null>; // waha/evolution
  // sessão (não-oficiais):
  startSession?(ch, webhookUrl): Promise<{qr?:string}>;
  getState?(ch): Promise<{status:string}>;
}
```
`ch` = row de `channels` já com credentials decifradas.

## Pipeline inbound agnóstico (`src/lib/channels/inbound.ts`)
Extraído do `webhook/route.ts` atual. `dispatchInboundMessage(accountId, channel, ev: NormalizedInbound)`:
1. dedup por `externalMessageId` (nova col? usar messages.message_id) — evita reprocesso.
2. resolve/cria contato por E.164 (reusa `findExistingContact`/`phonesMatch`).
3. resolve/cria conversa por **(account, contact, channel.id)**.
4. se media com base64/url → subir pro MinIO (bucket 'media') → media_url estável. Se provider tem `fetchInboundMedia` e veio sem base64 → buscar antes. EvoGo sem mídia → placeholder texto.
5. insere message (senderType 'customer'), bump unread, publishEvent SSE, flagBroadcastReply, dispatch flows/automations/ai (igual hoje).
Retorna {conversation, contact, isFirstInbound}.

## Roteamento de webhook
- `/api/webhooks/meta` — HMAC via META_APP_SECRET; acha canal por provider_meta->>'phone_number_id'; GET challenge por verify_token. (mantém `/api/whatsapp/webhook` como alias 307)
- `/api/webhooks/[provider]/[channelId]` — valida `webhook_secret` (query/header); acha canal por id; parseWebhook do provider → dispatchInboundMessage. Trata `session.status`/state → atualiza channels.status + notifica queda.

## Envio (`send-message.ts`)
Carrega canal por `conversation.channel_id` → registry → `provider.sendX`. Capability check ANTES (template em canal WAHA → 422 claro). Media outbound: meta manda por `link` (URL MinIO pública); não-oficiais mandam base64 (baixa a URL MinIO → base64). `automations/meta-send.ts` e `flows/meta-send.ts` delegam ao funil.

---

## Cheat-sheet dos providers (do RecebIA — code-tested)

### Normalização de telefone (todos)
`toWhatsAppNumber`: só dígitos; se começa 55 e len≥12 mantém; se len 10/11 prefixa 55. `isNonDirectJid`: descarta @g.us/@broadcast/@newsletter/@lid/status@.

### META (oficial) — já existe em meta-api.ts
- Auth `Authorization: Bearer <accessToken>`; base `graph.facebook.com/v21.0/{phoneNumberId}/messages`.
- Envio: `to` cru (sem @c.us). Media por `link` (URL pública). Templates ✓, interactive ✓, 9º dígito interno (sem resolve).
- Inbound: `entry[0].changes[0].value.messages[]`; status em `.statuses[]`. Media = id → getMediaUrl → download (proxy). HMAC x-hub-signature-256.
- Capabilities: templates✓ session24h✓ interactive✓ qr✗ inboundMedia✓.

### WAHA — engine NOWEB (evita "No LID"); auth `X-Api-Key`; session por nome
- **9º dígito: resolver chatId antes** → `GET /api/contacts/check-exists?phone=..&session=..` → `body.chatId` (fallback `${phone}@c.us`).
- Envio texto: `POST /api/sendText {session, chatId, text}`. Media: `/api/sendImage|sendFile|sendVoice|sendVideo {session, chatId, file:{mimetype,filename,data(base64 sem prefixo)}, caption}`. Voice = audio/ogg; codecs=opus.
- Inbound events: `message`, `message.any` (inclui fromMe), `message.ack` (status), `session.status`. NOWEB usa `from` (não `to`); fromMe: contato em `from` @lid → usar `_data.key.remoteJidAlt`. chat = `p.from||p.to`; se @lid e alt @s.whatsapp.net → alt.
- **Mídia inbound**: `p.media.url` vem com host interno (localhost:3000) → reescrever pro baseUrl; baixar com header `X-Api-Key` (env-first). id serializado `true_<chat>_<HASH>` → normalizar pegando último `_`.
- ack: 1 sent,2 delivered,3 read,4 played (só ≥2 interessa).
- Sessão: `GET /api/sessions/{s}`; criar `POST /api/sessions {name,start:true,config:{webhooks:[{url,events:[message,message.any,message.ack,session.status]}]}}`; QR `GET /api/{s}/auth/qr` (PNG) quando status SCAN_QR_CODE. **Trocar webhook exige restart da sessão** (`POST /api/sessions/{s}/restart`).
- Capabilities: templates✗ interactive✗ qr✓ inboundMedia✓ needsChatIdResolve✓ needsJitter✓. Evita 463 (WEBJS/privacy token) — mas usamos NOWEB no RecebIA; manter NOWEB.

### EVOLUTION API — Baileys; auth `apikey`; instance por nome na URL
- Envio: `POST /message/sendText/{instance} {number, text}`. Media: `/message/sendMedia/{instance} {number, mediatype, mimetype, media(base64), fileName, caption}`. Audio: `/message/sendWhatsAppAudio/{instance} {number, audio(base64 ogg/opus)}`. number = E.164 (sem @c.us). Sem @lid por padrão (JID direto).
- Inbound: event `MESSAGES_UPSERT`; `data.key.remoteJid` = telefone real (extrair dígitos). Status `MESSAGES_UPDATE` (status/update.status: 1..4).
- **Mídia inbound: fetch obrigatório** → `POST /chat/getBase64FromMediaMessage/{instance} {message:{key:{id,remoteJid,fromMe}, convertToMp4:false}}` → {base64,mimetype,fileName}. Não vem no webhook.
- Sessão: criar `POST /instance/create {instanceName, integration:'WHATSAPP-BAILEYS', qrcode:true}`; QR `GET /instance/connect/{instance}` → {base64 (data:image/png), pairingCode, state}. Webhook `POST /webhook/set/{instance} {webhook:{enabled,url,events:['MESSAGES_UPSERT','MESSAGES_UPDATE']}}`. Estado `GET /instance/connectionState/{instance}`.
- Capabilities: templates✗ interactive✗ qr✓ inboundMedia✓(via fetch) needsChatIdResolve✗ needsJitter✓. Sofre 463/Passkey.

### EVOGO (evolution-go / whatsmeow) — auth `apikey`; token por instância
- Envio: `POST /send/text {number, text}`. Media: `POST /send/media {number, url(base64 ou https), type:image|document|audio|video, caption, filename}`. Audio → send/media type audio. id em `data.Info.ID`.
- Inbound: event `Message`; `data.Info.{Chat,Sender,SenderAlt,IsFromMe,PushName}`. @lid: inbound tem telefone real em Chat/Sender e @lid em SenderAlt; fromMe tem @lid em Chat → precisa mapa lid→phone (tabela wa_lid_map). Status event `Receipt` (state delivered/read/played, `data.MessageIDs[]`).
- **Mídia inbound: NÃO entrega base64 no webhook e NÃO tem API de fetch** → `inboundMedia=false`. (é o bug do Alex — limitação estrutural do EvoGo). Guardar placeholder de texto com o tipo.
- Sessão: QR `GET /instance/qr` → {data.Qrcode "2@..."}. Webhook `POST /instance/connect {webhookUrl, subscribe:['ALL']}` (não chamar connect à toa — reseta webhook). Status `GET /instance/status` → data.LoggedIn/Connected.
- Capabilities: templates✗ interactive✗ qr✓ inboundMedia✗ needsChatIdResolve✗ needsJitter✓. Sofre 463.

### Regras transversais
- **463 / "envia mas não chega"**: Passkey/LID da Meta quebra não-oficiais; não recriar conexões que funcionam; retry com backoff no 463.
- **Grupos** (@g.us): ignorar no v1.
- **Jitter anti-ban** nos não-oficiais no envio em massa (Fase 5).
- Mídia inbound do CRM: baixar (base64/url) → subir MinIO (bucket 'media', já público) → media_url estável (melhor que o RecebIA que salvava em disco).
