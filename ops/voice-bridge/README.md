# Bridge da IA de voz (`ai_realtime_v2.js`)

Cópia versionada do bridge que atende as ligações. **Ele NÃO roda daqui** — roda
DENTRO do container `waha-voip-pilot-waha-1` na VPS, em `/tmp/ai_realtime_v2.js`.
O arquivo mora aqui só para ter histórico e revisão; até 24/07 ele existia apenas
solto na VPS, sem versionamento.

## Por que dentro do container
Usa `/app/node_modules/ws`, `/tmp/aimods/node_modules/werift` e fala com o waha em
`127.0.0.1:3999`. **Não existe `node` no host** — editar/reiniciar no host não tem
efeito nenhum.

## Portas
`3999` waha/gows · `3997` bridge v1 (piloto Maria, ainda vivo) · `3996` este bridge
(HTTP, recebe `call.received`) · `3998` relay WS (escuta/assumir).

## Deploy
```sh
scp ops/voice-bridge/ai_realtime_v2.js root@<vps>:/root/ai_realtime_v2.js
ssh root@<vps> '
BT=$(docker exec <container-web-do-crm> printenv VOICE_BRIDGE_TOKEN)
docker cp /root/ai_realtime_v2.js waha-voip-pilot-waha-1:/tmp/ai_realtime_v2.js
docker exec waha-voip-pilot-waha-1 sh /tmp/killbridge.sh    # mata DENTRO do container
sleep 2
docker exec -d -e BRIDGE_TOKEN="$BT" -e V2_WS_HOST=10.0.1.1 \
  waha-voip-pilot-waha-1 sh -c "cd /tmp && exec node /tmp/ai_realtime_v2.js > /tmp/v2.log 2>&1"
'
```
`WAHA_API_KEY` já está no env do container; `BRIDGE_TOKEN` **não** e precisa bater
com o `VOICE_BRIDGE_TOKEN` do CRM. `V2_WS_HOST=10.0.1.1` é o gateway PRIVADO da
rede docker do CRM: **nunca** subir o relay em `0.0.0.0` (a VPS não tem firewall e
o container usa a rede do host — seria áudio de cliente em `ws://` aberto na
internet). O TLS fica no Traefik, via `/data/coolify/proxy/dynamic/voice-relay.yaml`.

## Armadilhas
- `kill` a partir do host **não mata** (PID de namespace diferente).
- Um `grep ai_realtime_v2` se auto-matcha e parece um processo extra.
- Nunca injetar `call.received` sintético com id inventado apontando pra produção:
  vaza selo "IA em atendimento" na tela de todos.

## Env úteis
`VAD_SILENCE_MS` (padrão 1300) — quanto de silêncio antes de assumir que o cliente
terminou de falar. `HANDOFF_LINE`, `HANDOFF_POLL_MS`, `OVERFLOW_WAIT_MS`.
