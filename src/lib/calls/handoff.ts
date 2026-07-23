// ============================================================
// Voice handoff (Fatia 5B) — feature flag.
//
// DESLIGADO. O botão "Assumir" foi construído para o atendente entrar na MESMA
// ligação que a IA atende, mandando a própria oferta WebRTC pro gows. Dois
// testes ao vivo (23/07) mostraram que isso DERRUBA a ligação do cliente, e a
// documentação do `meowcaller` (a lib de chamadas por trás do gows) explica o
// porquê — ela declara que NÃO implementa transferência nem renegociação no
// meio da chamada, e que não dá pra anexar um segundo peer: a mídia fica presa
// a um único objeto `Call`. O gows chega a responder 201 na oferta nova, mas
// nunca re-liga o áudio nela.
//
// Ou seja: não é ajuste fino, é capacidade inexistente. Enquanto o botão
// estivesse visível, um clique acidental derrubaria um cliente ao vivo.
//
// O caminho certo é o RELAY: o bridge (que já é o dono do PCM nas duas vias)
// deixa de entregar a perna e passa a trocar quem está do outro lado — silencia
// a IA e liga o áudio do cliente ao navegador do atendente. Quando isso estiver
// no ar, basta virar esta flag para true (o resto do handoff — trava
// `claimed_by`, alerta, despedida da IA, `joinCall` — já está pronto e testado).
// ============================================================

export const VOICE_HANDOFF_ENABLED = false;
