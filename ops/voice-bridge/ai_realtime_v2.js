// FluxiaCRM — IA de voz nas ligações WhatsApp — v2 (fatia 2).
// Igual ao v1, MAS lê persona/voz/chaves do CRM por CANAL (endpoint interno),
// em vez do /tmp/ai_prompt.txt + env fixos. Escuta :3996 (v1 segue no :3997).
// Transporte: peer WebRTC (werift) + DataChannel "pcm" 16k s16le.
// Cérebro (texto): OpenAI Realtime GA. Voz: ElevenLabs streaming pcm_16000.
const http=require('http');
const crypto=require('crypto');
const https=require('https');
const WebSocket=require('/app/node_modules/ws');
const { RTCPeerConnection } = require('/tmp/aimods/node_modules/werift');
const RATE=16000, OAI_RATE=24000;
const API='http://127.0.0.1:3999', KEY=process.env.WAHA_API_KEY||'admin';
const MODEL='gpt-realtime-mini';
const EL_MODEL='eleven_flash_v2_5';
const CRM_BASE=process.env.CRM_BASE||'https://crm.salestecnologia.com.br';
const BRIDGE_TOKEN=process.env.BRIDGE_TOKEN||'';
const CHANNEL_OVERRIDE=process.env.VOICE_CHANNEL_ID||'';  // teste: força um canal (ignora a sessão da ligação)
const PORT=Number(process.env.V2_PORT||3996);  // NÃO usar PORT (=3999 do waha no container)
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);

function resample(buf,inR,outR){ if(inR===outR)return buf; const inN=buf.length/2, outN=Math.floor(inN*outR/inR), out=Buffer.alloc(outN*2);
  for(let i=0;i<outN;i++){ const p=i*inR/outR, i0=Math.floor(p), f=p-i0;
    const s0=buf.readInt16LE(Math.min(i0,inN-1)*2), s1=buf.readInt16LE(Math.min(i0+1,inN-1)*2);
    out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(s0+(s1-s0)*f))),i*2); } return out; }
function rms(buf){let s=0,n=buf.length/2;if(!n)return 0;for(let i=0;i<buf.length;i+=2)s+=buf.readInt16LE(i)**2;return Math.round(Math.sqrt(s/n));}

// apiPost agora recebe a SESSÃO da ligação (v1 era fixo 'default')
function apiPost(session,path,body){return new Promise(res=>{const data=JSON.stringify(body);const rq=http.request(`${API}/api/${session}/${path}`,{method:'POST',headers:{'X-Api-Key':KEY,'Content-Type':'application/json'}},r=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>res({st:r.statusCode,body:s}))});rq.on('error',e=>res({st:'ERR',body:e.message}));rq.write(data);rq.end();});}

// busca a config de voz do canal no CRM (por sessão; ou por canal no modo teste)
function fetchConfig(session){ return new Promise(res=>{
  const qs = CHANNEL_OVERRIDE ? ('channelId='+encodeURIComponent(CHANNEL_OVERRIDE)) : ('session='+encodeURIComponent(session));
  https.get(CRM_BASE+'/api/internal/voice-config?'+qs, { headers:{ Authorization:'Bearer '+BRIDGE_TOKEN } }, r=>{
    let s=''; r.on('data',d=>s+=d); r.on('end',()=>{ try{res(JSON.parse(s))}catch{ res(null); } });
  }).on('error',e=>{ log('cfg err',e.message); res(null); }); }); }

// checa se um HUMANO já atendeu a ligação (transbordo) — lê call_logs.claimed_by
function checkClaimed(session, cid){ return new Promise(res=>{
  const qs='callId='+encodeURIComponent(cid);
  https.get(CRM_BASE+'/api/internal/voice-call-claimed?'+qs, { headers:{ Authorization:'Bearer '+BRIDGE_TOKEN } }, r=>{
    let s=''; r.on('data',d=>s+=d); r.on('end',()=>{ try{res(JSON.parse(s).claimed===true)}catch{res(false)} });
  }).on('error',()=>res(false)); }); }

// HANDOFF (fatia 5B): durante a call ATIVA, checa se um humano clicou "Assumir".
// Sinal = call_logs.claimed_by preenchido (a IA nunca escreve claimed_by), então
// != null significa que um humano assumiu — distinto do transbordo (que também
// olha status='answered', que a própria IA seta).
function checkHandoff(cid){ return new Promise(res=>{
  const qs='callId='+encodeURIComponent(cid);
  https.get(CRM_BASE+'/api/internal/voice-handoff?'+qs, { headers:{ Authorization:'Bearer '+BRIDGE_TOKEN } }, r=>{
    let s=''; r.on('data',d=>s+=d); r.on('end',()=>{ try{res(JSON.parse(s).handoff===true)}catch{res(false)} });
  }).on('error',()=>res(false)); }); }

// ============================================================
// RELAY — o bridge como dono da mídia (base da fatia 5B v2)
//
// O motor NÃO deixa passar a ligação de um peer para outro: o `meowcaller`
// (lib por trás do gows) não implementa transferência nem renegociação no meio
// da chamada, e a mídia fica presa a um único `Call`. Tentar entregar a perna
// derruba o cliente (comprovado ao vivo em 23/07).
//
// Então invertemos: o bridge FICA com a perna a ligação inteira e apenas troca
// quem está do outro lado. Quem quiser ouvir/falar se conecta AQUI por
// WebSocket e trafega o mesmo PCM 16 kHz s16le que já corre no DataChannel:
//   modo 'listen' → só RECEBE a voz do cliente (escuta de supervisor, risco zero)
//   modo 'talk'   → recebe E injeta (o atendente assume; a IA fica muda)
// ============================================================
const liveCalls = new Map();   // callId -> relay da ligação viva


// ---- números por extenso (pt-BR) -----------------------------------------
// A persona MANDA falar por extenso, e mesmo assim o modelo emite "1248" de vez
// em quando — e a voz lê número cru de um jeito enrolado. Confiar no prompt já
// falhou, então a conversão vira código: determinística, sempre.
const _UNI=['zero','um','dois','três','quatro','cinco','seis','sete','oito','nove','dez','onze','doze','treze','quatorze','quinze','dezesseis','dezessete','dezoito','dezenove'];
const _DEZ=['','','vinte','trinta','quarenta','cinquenta','sessenta','setenta','oitenta','noventa'];
const _CEM=['','cento','duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos'];
function extenso(n){
  n=Math.floor(Math.abs(Number(n)||0));
  if(n<20) return _UNI[n];
  if(n<100){ const d=Math.floor(n/10), r=n%10; return _DEZ[d]+(r?' e '+_UNI[r]:''); }
  if(n===100) return 'cem';
  if(n<1000){ const c=Math.floor(n/100), r=n%100; return _CEM[c]+(r?' e '+extenso(r):''); }
  if(n<1000000){ const m=Math.floor(n/1000), r=n%1000;
    const mm=(m===1?'mil':extenso(m)+' mil');
    return r ? mm+(r<100?' e ':' ')+extenso(r) : mm; }
  return String(n);                      // acima de 1 milhão: deixa como veio
}
function numerosPorExtenso(t){
  if(!t) return t;
  // dinheiro primeiro (senão "125,00" viraria dois inteiros soltos)
  t=t.replace(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/g,(_m,i,c)=>{
    const reais=Number(String(i).replace(/\./g,'')), cent=c?Number(c):0;
    let s=extenso(reais)+(reais===1?' real':' reais');
    if(cent) s+=' e '+extenso(cent)+(cent===1?' centavo':' centavos');
    return s; });
  // CÓDIGO DE PRODUTO colado (P13, G45): a voz enrola no glifo "P13". Dá as
  // PALAVRAS pro TTS — "P13" vira "P treze" — pra sair limpo. (Só na voz; os
  // dados da ferramenta não passam por aqui, então o código cru é preservado lá.)
  t=t.replace(/\b([A-Za-z]{1,2})(\d{1,3})\b/g,(_m,l,d)=>l.toUpperCase()+' '+extenso(Number(d)));
  // inteiros SOLTOS. "1248" vira "mil duzentos e quarenta e oito".
  t=t.replace(/(^|[^\p{L}\d])(\d{1,6})(?![\d\p{L}])/gu,(_m,pre,n)=>pre+extenso(Number(n)));
  return t;
}

// ---- som de TECLADO de fundo (escritório) ------------------------------
// Leito de digitação BAIXA tocando a ligação INTEIRA — como um atendente num
// escritório movimentado — pra não soar como IA num silêncio de estúdio. Toca
// sozinho nos silêncios e por baixo da voz dela quando fala (ver mixTyping no
// drainer). Sintetizado aqui (sem asset externo): cliques curtos e irregulares.
const TYPING_ON = (process.env.TYPING_SOUND||'on') !== 'off';
// Leito de fundo (escritório) tocando a ligação INTEIRA. Dois volumes: sozinho
// no silêncio (TYPING_GAIN) e mais baixo POR BAIXO da voz dela (TYPING_UNDER_GAIN),
// pra não competir com a fala. Ambos ajustáveis por env, sem redeploy pesado.
const TYPING_GAIN = Number(process.env.TYPING_GAIN||0.06);
const TYPING_UNDER_GAIN = Number(process.env.TYPING_UNDER_GAIN||0.035);

// PRÉ-BUFFER da voz: no começo de CADA fala dela, segura um tiquinho de áudio
// antes de tocar. Sem isso, a abertura sai em "câmera lenta" — a ElevenLabs
// ainda está enchendo a fila quando ela começa a falar, a fila esvazia e
// engasga. Segurando ~200ms, a abertura sai inteira. PREROLL_MAX_MS é o teto:
// falas curtas (ex.: "Sim!") que nunca juntam 200ms tocam assim mesmo.
const PREROLL_BYTES = Math.floor(RATE*2*Number(process.env.PREROLL_MS||280)/1000);
const PREROLL_MAX_MS = Number(process.env.PREROLL_MAX_MS||480);
function makeTypingPcm(seconds){
  const n = RATE*seconds, buf = Buffer.alloc(n*2); let t = 0, keys = 0;
  const put=(i,v)=>{ if(i>=0&&i<n) buf.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v))), i*2); };
  while(t < n){
    // pausa antes da próxima tecla; de vez em quando uma pausa maior (fim de palavra)
    keys++;
    const gap = (keys%9===0) ? 0.30+Math.random()*0.25 : 0.05+Math.random()*0.09;
    t += Math.floor(RATE*gap); if(t>=n) break;
    const dur = Math.floor(RATE*(0.016+Math.random()*0.018));   // ~16-34ms
    const fr = 1600 + Math.random()*1800;                        // ressonância do clique
    const tau = RATE*(0.004+Math.random()*0.004);               // decaimento ~4-8ms
    for(let i=0;i<dur;i++){
      const env = Math.exp(-i/tau);
      const s = (Math.random()*2-1)*0.55 + Math.sin(2*Math.PI*fr*i/RATE)*0.45;
      put(t+i, s*env*6500);
    }
    t += dur;
  }
  return buf;
}
const TYPING_PCM = TYPING_ON ? makeTypingPcm(22) : Buffer.alloc(0);  // loop longo p/ não soar repetitivo

const OVERFLOW_WAIT_MS = Number(process.env.OVERFLOW_WAIT_MS||15000);
const HANDOFF_POLL_MS = Number(process.env.HANDOFF_POLL_MS||2000);
// frase que a IA fala ao ser assumida por um humano, antes de soltar a perna
const HANDOFF_LINE = process.env.HANDOFF_LINE||'Só um momento, tá? Vou te passar para um atendente agora.';

async function handleCall(cid, session, payload){
  // CHAMADA DE VÍDEO: a IA não atende. Ela é só voz — atender deixaria o cliente
  // olhando uma tela preta, falando com uma atendente que nunca vai aparecer.
  // Ignorando aqui, a chamada segue tocando para um humano, que pode atender com
  // vídeo de verdade. (O gows manda a flag em payload.isVideo desde sempre;
  // ninguém a lia, então até 24/07 a IA atendia vídeo como se fosse voz.)
  if(payload && payload.isVideo===true){
    log('CALL',cid,'→ é chamada de VÍDEO, a IA não atende (deixa tocar pro humano)');
    return;
  }
  const cfg = await fetchConfig(session);
  if(!cfg || !cfg.found){ log('CALL',cid,'sessão',session,'→ sem canal no CRM, ignoro'); return; }
  if(!cfg.enabled){ log('CALL',cid,'canal',cfg.channelName,'→ IA de voz DESLIGADA, ignoro'); return; }
  if(!cfg.openaiKey || !cfg.elevenlabsKey){ log('CALL',cid,'canal',cfg.channelName,'→ faltam chaves, ignoro'); return; }

  // config do canal (vinda do CRM) — no escopo da ligação
  const OPENAI_KEY=cfg.openaiKey, XI_KEY=cfg.elevenlabsKey;
  const VOICE_ID=cfg.voiceId || '33B4UnXyTNbgLmdEDh5P';
  // Base blindada: garante pt-BR e estilo de telefone MESMO com persona curta
  // (sem isto, um prompt minúsculo faz o OpenAI cair no inglês/defaults).
  const BASE='Você é uma atendente de voz ao TELEFONE. Fale SEMPRE em português do Brasil (pt-BR), com frases curtas e naturais de telefone. NUNCA responda em inglês. Nunca invente preço nem endereço.';
  let PROMPT = BASE + (cfg.prompt ? `\n\n--- Persona e regras deste atendimento ---\n${cfg.prompt}` : '');
  PROMPT += '\n\n--- REGISTRO DO PEDIDO (OBRIGATÓRIO — use a FERRAMENTA, UMA ÚNICA VEZ) ---\n'
    + 'A ferramenta notificar_pedido é o ÚNICO jeito de registrar e despachar o pedido — falar que vai registrar NÃO registra nada. Cada chamada MANDA um pedido pro grupo da entrega, então chamar duas vezes gera pedido DUPLICADO. Por isso a ferramenta é chamada NO MÁXIMO UMA VEZ na ligação inteira.\n'
    + 'ORDEM OBRIGATÓRIA (nunca pule etapa): (1) COLETE tudo: produto, endereço completo (rua, número e bairro) e forma de pagamento. (2) FAÇA O RESUMO em voz alta — repita produto, endereço completo, pagamento e valor. (3) PERGUNTE explicitamente se está tudo certo: "Posso confirmar e já mandar pra entrega? Está tudo certo?". (4) ESPERE o cliente responder. (5) SÓ quando o cliente CONFIRMAR de forma clara (ex.: "sim", "está certo", "pode mandar", "isso") é que você chama notificar_pedido — UMA vez só.\n'
    + 'PROIBIDO: chamar notificar_pedido durante o resumo, antes da pergunta de confirmação, ou antes do cliente responder "sim/está certo". O RESUMO NÃO É REGISTRO — é só pra ele conferir. Registrar só depois do "sim" dele.\n'
    + 'SE O CLIENTE CORRIGIR qualquer coisa no resumo (bairro, número, produto, pagamento): NÃO chame a ferramenta. Ajuste o dado, refaça o resumo com a correção e pergunte de novo "agora está tudo certo?". Só chame notificar_pedido depois do "sim" final. Assim ela nunca é chamada duas vezes.\n'
    + 'JÁ CHAMOU? Se você já chamou notificar_pedido uma vez nesta ligação, NUNCA chame de novo — nem se o cliente corrigir algo depois. Nesse caso diga que vai ajustar e que um atendente confirma o acerto (ver seção CORREÇÕES).\n'
    + 'OUTRAS REGRAS: (a) NUNCA diga "vou registrar", "já encaminhei", "vou despachar" sem ter chamado a ferramenta. (b) Só DEPOIS que a ferramenta responder é que você confirma o pedido pro cliente — a despedida e o [DESLIGAR] seguem a seção FECHAMENTO. (c) NUNCA use [DESLIGAR] com um pedido em aberto sem ter chamado a ferramenta. (d) Nos DADOS da ferramenta, escreva valores e números em ALGARISMOS (ex: valor "R$ 125,00", troco "R$ 150,00", número da casa "53") — falar por extenso vale SÓ para a voz, NUNCA para a ferramenta.\n'
    + '\n--- FECHAMENTO (não atropele a despedida) ---\n'
    + 'Depois que a ferramenta registrar o pedido, faça UMA fala curta: confirme o resumo do pedido e diga que já vai encaminhar pra entrega. E PARE — espere o cliente responder. NÃO emende "de nada", "por nada" nem "tenha um ótimo dia" nessa mesma fala, e NÃO use [DESLIGAR] ainda.\n'
    + 'NUNCA diga "de nada"/"por nada" antes do cliente te agradecer — isso é RESPOSTA a um "obrigado". Só use depois que ele agradecer de verdade.\n'
    + 'Quando o cliente se despedir ou agradecer (obrigado, valeu, ok, tá bom), aí sim feche a despedida e o [DESLIGAR] JUNTOS, numa fala SÓ: "Por nada! Qualquer coisa é só chamar, tenha um ótimo dia!" e no fim dessa MESMA fala o [DESLIGAR].\n'
    + 'A despedida é dita UMA ÚNICA VEZ. Depois de dizer "por nada"/"tenha um ótimo dia", NÃO fale mais nada e NUNCA repita a despedida numa segunda fala. Se você já se despediu, é só [DESLIGAR] — sem repetir.\n'
    + 'NUNCA imagine ou responda uma fala que o cliente ainda não disse.\n'
    + '\n--- RITMO E CORREÇÕES (não atropele o cliente) ---\n'
    + 'Deixe o cliente TERMINAR de falar. Se ele pausar pensando, ESPERE — não emende pergunta nem ofereça produto no meio da fala dele.\n'
    + 'SE O CLIENTE FIZER UMA PERGUNTA (ex: perguntar o preço, o valor de novo, prazo, forma de pagamento), RESPONDA a pergunta primeiro. NÃO vá para o fechamento nem chame ferramenta enquanto houver pergunta em aberto — só siga depois de responder e o cliente demonstrar que quer prosseguir.\n'
    + 'Uma dúvida repetida NÃO é sinal de fechar — é sinal de que ele quer entender melhor. Responda com calma.\n'
    + 'NÃO chame notificar_pedido enquanto o cliente estiver corrigindo qualquer dado. Registre só quando ele confirmar que está tudo certo.\n'
    + 'NOME DE RUA: se o cliente corrigir a rua e você entender diferente do que ele disse, NÃO insista na sua versão — repita o que ELE falou. Se corrigir duas vezes, peça pra soletrar ("pode soletrar a rua pra mim?").\n'
    + 'SE O CLIENTE CORRIGIR UM DADO DEPOIS DE VOCÊ JÁ TER REGISTRADO: NUNCA cancele o pedido e NUNCA desligue por causa disso. Diga que vai ajustar, confirme o dado certo com ele e avise que um atendente confirma o acerto. NUNCA use marcar_sem_venda com "cancelado" por causa de correção de endereço — cancelado é só quando o CLIENTE desiste da compra.\n'
    + 'SEM VENDA: se a ligação terminar SEM fechar pedido, antes de se despedir chame a ferramenta marcar_sem_venda com o status certo (interessado = quis saber mas não fechou; cancelado = desistiu de um pedido; nao_quis = não quis comprar). Isso serve pra reativação depois. Só então use [DESLIGAR].';
  if(cfg.greeting) PROMPT += `\n\nComece a ligação dizendo exatamente: "${cfg.greeting}"`;
  log('CALL',cid,'canal',cfg.channelName,'→ atende | voz',VOICE_ID.slice(0,6),'| modo',cfg.mode);

  // telefone de quem ligou (mesma lógica do webhook do CRM) → resolver a conversa
  const P=payload||{};
  const rawFrom=String(P.from||'');
  const altJid=String((P._data && (P._data.CallCreatorAlt || (P._data.Data && P._data.Data.Attrs && P._data.Data.Attrs.caller_pn))) || '');
  const phoneSrc = /@(c\.us|s\.whatsapp\.net)$/.test(altJid) ? altJid : (/@(c\.us|s\.whatsapp\.net)$/.test(rawFrom) ? rawFrom : rawFrom);
  const callerPhone = phoneSrc.split('@')[0].split(':')[0].replace(/\D/g,'');
  const CALL_START=Date.now();
  const transcript=[]; let posted=false, posted2=false;
  // p/ ordenar o diálogo por TEMPO: o cliente é carimbado com o instante em que
  // começou a falar (speech_started), a IA com o instante em que começou a
  // responder (response.created) — a transcrição do Whisper chega atrasada, o
  // que embaralharia a ordem se usássemos o momento em que o texto fica pronto.
  let lastSpeechAt=0, lastRespAt=0;
  function postTranscript(){ if(posted||transcript.length===0)return; posted=true;
    const ordered=[...transcript].sort((a,b)=>(a.ts||0)-(b.ts||0));
    const bodyObj={ callId:cid, from:callerPhone, durationSec:Math.round((Date.now()-CALL_START)/1000), lines:ordered };
    if(CHANNEL_OVERRIDE) bodyObj.channelId=CHANNEL_OVERRIDE; else bodyObj.session=session;
    const data=JSON.stringify(bodyObj);
    const u=new URL(CRM_BASE+'/api/internal/voice-transcript');
    const req=https.request({hostname:u.hostname,port:443,path:u.pathname,method:'POST',
      headers:{'Authorization':'Bearer '+BRIDGE_TOKEN,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},
      r=>{ let s=''; r.on('data',d=>s+=d); r.on('end',()=>log('[transcript] POST',r.statusCode,s.slice(0,90))); });
    req.on('error',e=>log('[transcript] err',e.message)); req.write(data); req.end();
  }

  // ---- monitor ao vivo (Fatia 5): transmite cada fala na hora ----
  function postLive(phase, role, text, ts){
    const bodyObj={ callId:cid, phase };
    if(CHANNEL_OVERRIDE) bodyObj.channelId=CHANNEL_OVERRIDE; else bodyObj.session=session;
    if(phase==='start') bodyObj.from=callerPhone;
    if(role){ bodyObj.role=role; bodyObj.text=text; if(ts) bodyObj.ts=ts; }
    const data=JSON.stringify(bodyObj);
    const u=new URL(CRM_BASE+'/api/internal/voice-live');
    const req=https.request({hostname:u.hostname,port:443,path:u.pathname,method:'POST',
      headers:{'Authorization':'Bearer '+BRIDGE_TOKEN,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},
      r=>{ r.on('data',()=>{}); r.on('end',()=>{}); });
    req.on('error',()=>{}); req.write(data); req.end();
  }

  // ---- ferramentas (function-calling) → endpoints internos do CRM ----
  const fnNames={};  // call_id -> nome da função
  function callCrmTool(path, extra){ return new Promise(res=>{
    const bodyObj={ ...extra }; if(CHANNEL_OVERRIDE) bodyObj.channelId=CHANNEL_OVERRIDE; else bodyObj.session=session;
    const data=JSON.stringify(bodyObj);
    const u=new URL(CRM_BASE+'/api/internal/voice-tools/'+path);
    const req=https.request({hostname:u.hostname,port:443,path:u.pathname,method:'POST',
      headers:{'Authorization':'Bearer '+BRIDGE_TOKEN,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},
      r=>{ let s=''; r.on('data',d=>s+=d); r.on('end',()=>{ log('[tool] '+path,r.statusCode,s.slice(0,90)); try{res(JSON.parse(s))}catch{res({ok:r.statusCode<300})} }); });
    req.on('error',e=>{ log('[tool] err',e.message); res({ok:false}); }); req.write(data); req.end();
  }); }
  async function handleTool(name, callId, argsRaw){
    let args={}; try{ args=JSON.parse(argsRaw||'{}') }catch{}
    log('[tool] chamada', name, JSON.stringify(args).slice(0,140));
    let result={ ok:false, erro:'ferramenta desconhecida' };
    if(name==='notificar_pedido'){
      if(!args.telefone && callerPhone) args.telefone='+'+callerPhone;
      result = await callCrmTool('register-order', { from: callerPhone, order: args });
    } else if(name==='marcar_sem_venda'){
      result = await callCrmTool('mark-status', { from: callerPhone, status: args.status, motivo: args.motivo });
    }
    // devolve o resultado pro modelo e deixa ele continuar a fala
    try{
      ws.send(JSON.stringify({ type:'conversation.item.create', item:{ type:'function_call_output', call_id:callId, output:JSON.stringify(result) } }));
      ws.send(JSON.stringify({ type:'response.create' }));
    }catch(e){ log('[tool] resposta err', e.message); }
  }

  // TRANSBORDO: no modo overflow, espera alguns toques e só atende se ninguém pegou.
  if(cfg.mode==='overflow'){
    log('CALL',cid,'→ modo TRANSBORDO: aguardando',OVERFLOW_WAIT_MS/1000,'s pelo humano');
    await new Promise(r=>setTimeout(r,OVERFLOW_WAIT_MS));
    if(await checkClaimed(session,cid)){ log('CALL',cid,'→ humano atendeu, IA fica quieta'); return; }
    log('CALL',cid,'→ ninguém pegou, IA assume o transbordo');
  }

  const acc=await apiPost(session,'calls/accept',{id:cid}); log('accept',acc.st);
  // Se o motor recusou o accept, a ligação não existe mais (desligou, id velho).
  // Parar AQUI é o que impede o cascateamento: abrir o cérebro depois disso faz
  // a IA gerar saudação para o vazio e postar uma linha "ao vivo" de uma ligação
  // fantasma — o selo "IA em atendimento" fica preso na tela de todo mundo.
  if(typeof acc.st==='number' && acc.st>=300){
    log('CALL',cid,'→ accept recusado pelo motor ('+acc.st+'), desisto sem abrir nada');
    return;
  }
  const pc=new RTCPeerConnection({ iceServers: [] });
  const dc=pc.createDataChannel('pcm',{ ordered:true });

  // Relay desta ligação: quem está ouvindo/falando do "outro lado" além da IA.
  // `talk` ligado = um atendente assumiu → a IA cala a boca (não toca áudio nem
  // alimenta o cérebro), e o microfone dele entra no lugar.
  // Eco da voz da IA guardado para a ESCUTA. O áudio dela nasce aqui dentro e
  // vai direto pro DataChannel — nunca passa pelo caminho de entrada —, então
  // sem isto o supervisor só ouviria o cliente (metade da conversa).
  //
  // Mixar (somar) em vez de reencaminhar os dois é obrigatório: o cliente manda
  // um frame a cada 20 ms sem parar, e se a voz da IA fosse enviada como frames
  // EXTRA o ouvinte receberia o dobro do que consegue tocar — a fila cresceria
  // para sempre e o atraso junto. Somando, sai um frame por tick, no relógio do
  // cliente.
  let aiEcho = Buffer.alloc(0);
  const AI_ECHO_MAX = RATE * 2;               // ~1 s; ouvinte lento não vira memória presa

  const relay = {
    clients: new Set(),
    get talk(){ for(const c of this.clients) if(c.mode==='talk') return true; return false; },
    // voz do cliente → todos os ouvintes conectados
    fanout(buf){ for(const c of this.clients){ if(c.ws.readyState===1){ try{ c.ws.send(buf) }catch{} } } },
    // voz do atendente → a ligação
    toCall(buf){ if(dc.readyState==='open'){ try{ dc.send(buf) }catch{} } },
  };
  liveCalls.set(cid, relay);
  const unregisterRelay=()=>{ if(liveCalls.get(cid)===relay){ liveCalls.delete(cid);
    for(const c of relay.clients){ try{ c.ws.close() }catch{} } relay.clients.clear(); } };

  let aiQ=Buffer.alloc(0);
  const FRAME=Math.floor(RATE*0.02)*2; // 640 bytes = 20ms
  // Leito de teclado (escritório) SEMPRE tocando. Em vez de enfileirar frames de
  // teclado em aiQ (o que atrasaria a voz dela), o teclado é SOMADO no frame na
  // hora de enviar: sozinho no silêncio, e por baixo da voz dela quando ela fala.
  // `typingOff` anda a cada frame enviado → o leito corre em tempo real.
  let typingOff=0;
  function mixTyping(frame, gain){
    const out=Buffer.from(frame);   // cópia; não mexe no original
    for(let i=0;i<out.length;i+=2){
      if(typingOff>=TYPING_PCM.length) typingOff=0;
      let v = out.readInt16LE(i) + Math.round(TYPING_PCM.readInt16LE(typingOff)*gain);
      if(v>32767)v=32767; else if(v<-32768)v=-32768;
      out.writeInt16LE(v,i);
      typingOff+=2;
    }
    return out;
  }
  let playStartAt=null, bytesSent=0, lastAiSentAt=0, lastVoiceAt=0, bedArmed=false, holdStartAt=null;
  const drainer=setInterval(()=>{ if(dc.readyState!=='open')return; const now=Date.now();
    // Atendente no comando: a IA não toca nada (o áudio dele já vai direto).
    if(relay.talk){ aiQ=Buffer.alloc(0); playStartAt=null; return; }
    // Leito só liga DEPOIS que ela começou a falar (bedArmed). No atendimento,
    // ela fala primeiro (a saudação sai limpa, sem teclado no silêncio inicial)
    // e o escritório entra no fundo a partir daí — como o Alex pediu.
    const bed = TYPING_ON && !handoffStarted && bedArmed;
    const emit=(f)=>{ try{dc.send(f)}catch{}; if(relay.clients.size && aiEcho.length<AI_ECHO_MAX) aiEcho=Buffer.concat([aiEcho,f]); lastAiSentAt=now; };
    if(aiQ.length>=FRAME){
      if(playStartAt===null){
        // PRÉ-BUFFER: no início da fala, segura até juntar PREROLL_BYTES (ou
        // estourar PREROLL_MAX_MS). Enquanto segura, ainda toca o teclado no
        // fundo se o escritório já estiver armado — só a VOZ espera encher.
        if(holdStartAt===null) holdStartAt=now;
        const ready = aiQ.length>=PREROLL_BYTES || (now-holdStartAt)>=PREROLL_MAX_MS;
        if(!ready){ if(bed) emit(mixTyping(Buffer.alloc(FRAME), TYPING_UNDER_GAIN)); trackQ(); return; }
        playStartAt=now; bytesSent=0; holdStartAt=null;
      }
      const shouldBytes=Math.floor((now-playStartAt)/1000*RATE*2/FRAME)*FRAME;
      while(bytesSent<shouldBytes && aiQ.length>=FRAME){ let f=aiQ.subarray(0,FRAME); aiQ=aiQ.subarray(FRAME);
        if(bed) f=mixTyping(f, TYPING_UNDER_GAIN);   // voz da IA + teclado bem por baixo
        emit(f); bytesSent+=FRAME; lastVoiceAt=now; bedArmed=true; }
    } else {
      // Fila vazia. Só REINICIA o relógio se a fala realmente acabou (>300ms
      // sem áudio). Reiniciar a cada soluço da ElevenLabs zerava o `shouldBytes`
      // e inseria uma lacuna a cada engasgo — a fala saía picada, com aquele
      // efeito de "câmera lenta". Mantendo o relógio, o que atrasou é enviado
      // em seguida (o receptor tem buffer) e a frase sai inteira.
      if(aiQEmptiedAt && Date.now()-aiQEmptiedAt>300){ playStartAt=null; holdStartAt=null; }
      // SILÊNCIO: mantém o escritório vivo — 1 frame de teclado a cada tick (20ms
      // = tempo real). Não entra em aiQ (não atrasa a voz) e não conta como "IA
      // falando", então não muta o cliente nem atrapalha o barge-in.
      // Se a voz engasgou HÁ POUCO (<700ms), ainda estamos no MEIO da fala dela —
      // o vão é um soluço da ElevenLabs, não um silêncio de escritório. Nesse caso
      // preenche com o teclado BEM baixinho (under), pra o engasgo não virar um
      // estalo alto no meio da frase. Silêncio de verdade usa o volume normal.
      if(bed){ const g = (now-lastVoiceAt < 700) ? TYPING_UNDER_GAIN : TYPING_GAIN;
        emit(mixTyping(Buffer.alloc(FRAME), g)); }
    }
    trackQ(); },20);
  let iaPlayed=0, aiQEmptiedAt=0, wasEmpty=true;
  const trackQ=()=>{ const empty=aiQ.length<FRAME;
    if(empty&&!wasEmpty){ aiQEmptiedAt=Date.now();
      if(hangupAfterPlay && !hangingUp){ hangingUp=true; setTimeout(()=>doHangup(),800); } }
    wasEmpty=empty; };
  // Cauda do eco: depois que a fala dela drena, ela espera AI_TAIL_MS antes de
  // voltar a escutar — no viva-voz o eco da própria voz ainda ecoa uns 100s de
  // ms na caixa do cliente; escutar cedo demais captaria esse rabo como "fala".
  const AI_TAIL_MS=Number(process.env.AI_TAIL_MS||500);
  const aiTalking=()=> aiQ.length>=FRAME || (Date.now()-aiQEmptiedAt < AI_TAIL_MS);

  function startTTSTurn(){
    const url=`wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${EL_MODEL}&output_format=pcm_16000&language_code=pt`;
    const el=new WebSocket(url,{ headers:{ 'xi-api-key':XI_KEY }});
    let open=false, pend=[], flushed=false, got=0;
    el.on('open',()=>{ open=true;
      el.send(JSON.stringify({ text:' ', voice_settings:{stability:0.5,similarity_boost:0.85,speed:1.0} }));
      for(const t of pend) el.send(JSON.stringify({text:t})); pend=[];
      if(flushed){ try{el.send(JSON.stringify({text:''}))}catch{} } });
    el.on('message',raw=>{ let m; try{m=JSON.parse(raw)}catch{return;}
      if(m.audio){ const b=Buffer.from(m.audio,'base64'); aiQ=Buffer.concat([aiQ,b]); iaPlayed+=b.length; got+=b.length; trackQ(); } });
    el.on('error',e=>log('EL err',e.message));
    return { push:(t)=>{ if(!t)return; if(open)el.send(JSON.stringify({text:t})); else pend.push(t); },
             flush:()=>{ flushed=true; if(open){ try{el.send(JSON.stringify({text:''}))}catch{} } },
             close:()=>{ try{el.close()}catch{} } };
  }
  let ttsTurn=null, responding=false, barged=false, bargeUntil=0, loudRun=0;
  // Robustez a RUÍDO/VIVA-VOZ (tudo ajustável por env, pra afinar sem redeploy):
  const ECHO_GATE=Number(process.env.ECHO_GATE||1500);   // energia pra contar como "alto"
  const BARGE_FRAMES=Number(process.env.BARGE_FRAMES||5); // frames ALTOS seguidos p/ cortar (20ms cada → 100ms)
  const NOISE_FLOOR=Number(process.env.NOISE_FLOOR||300); // abaixo disto (IA calada) = silêncio injetado (zeros)
  let turnBuf='', turnFull='', hangupAfterPlay=false, hangingUp=false;
  // handoff (fatia 5B): humano assumiu → fala HANDOFF_LINE e solta a perna SEM calls/end
  let handoffPoll=null, handoffStarted=false;
  const ttsFeed=(delta)=>{ turnFull+=delta; turnBuf+=delta;
    const o=turnBuf.lastIndexOf('['); let safe,tail;
    if(o===-1){ safe=turnBuf; tail=''; } else { safe=turnBuf.slice(0,o); tail=turnBuf.slice(o); }
    // Segura um número AINDA EM FORMAÇÃO no fim do pedaço: o texto chega em
    // deltas, então "1248" pode vir como "12"+"48" — converter na hora diria
    // "doze" e depois "quarenta e oito". Espera o número terminar.
    const emFormacao=safe.match(/(?:R\$\s*)?\d[\d.,]*$/);
    if(emFormacao){ tail=emFormacao[0]+tail; safe=safe.slice(0,safe.length-emFormacao[0].length); }
    if(safe&&ttsTurn) ttsTurn.push(numerosPorExtenso(safe)); turnBuf=tail; };
  const ttsFinish=()=>{ const rem=numerosPorExtenso(turnBuf.replace(/\[[^\]]*\]/g,'')); if(rem.trim()&&ttsTurn) ttsTurn.push(rem);
    if(ttsTurn) ttsTurn.flush();
    if(/\[DESLIGAR\]/i.test(turnFull)){ hangupAfterPlay=true; log('[fim] IA sinalizou desligar após a fala'); }
    turnBuf=''; turnFull=''; };
  async function doHangup(){ log('[fim] encerrando ligação'); unregisterRelay(); try{ await apiPost(session,'calls/end',{id:cid}); }catch{}
    postTranscript(); if(!posted2){posted2=true;postLive('end');} clearInterval(drainer); if(handoffPoll)clearInterval(handoffPoll); try{ws.close()}catch{}; try{pc.close()}catch{} }

  // HANDOFF: humano clicou "Assumir". Corta o cérebro, fala a frase de aviso e,
  // quando ela drenar, solta SÓ a perna da IA (pc.close) — SEM calls/end, pra a
  // call seguir viva na perna do humano (o gows multiplexa).
  function doHandoff(){
    if(handoffStarted) return; handoffStarted=true;
    log('[handoff] humano assumiu → aviso e solto a perna (sem encerrar)');
    if(handoffPoll){ clearInterval(handoffPoll); handoffPoll=null; }
    try{ if(responding) ws.send(JSON.stringify({type:'response.cancel'})); }catch{}
    responding=false; hangupAfterPlay=false;
    if(ttsTurn){ try{ttsTurn.close()}catch{} }
    aiQ=Buffer.alloc(0);                 // corta o que estava tocando
    const at=Date.now();
    transcript.push({role:'ai',text:HANDOFF_LINE,ts:at}); postLive('line','ai',HANDOFF_LINE,at);
    ttsTurn=startTTSTurn(); ttsTurn.push(HANDOFF_LINE); ttsTurn.flush();
    // Solta a perna SÓ depois que a frase tocou E drenou. iaPlayed cresce a cada
    // chunk do ElevenLabs; espero ver áudio novo (sawAudio) e a fila esvaziar —
    // assim não solto no instante em que limpei o aiQ (antes da frase começar).
    const before=iaPlayed; let sawAudio=false;
    const chk=setInterval(()=>{
      if(iaPlayed>before) sawAudio=true;
      if(released || (sawAudio && aiQ.length<FRAME)){ clearInterval(chk); doRelease(); }
    }, 150);
    setTimeout(()=>{ try{clearInterval(chk)}catch{}; doRelease(); }, 6000); // rede de segurança
  }
  let released=false;
  async function doRelease(){
    if(released) return; released=true;
    log('[handoff] IA em silêncio — transporte fica pro humano assumir');
    postTranscript(); if(!posted2){posted2=true;postLive('end');}
    clearInterval(drainer); if(handoffPoll)clearInterval(handoffPoll);
    try{ws.close()}catch{}                      // só o cérebro (OpenAI)
    // NÃO fecha pc/dc e NÃO chama calls/end. O gows tem UM transporte por
    // ligação: quando o navegador do humano manda a oferta dele, o gows TROCA
    // o transporte (e o nosso dc fecha sozinho). Fechar o pc aqui avisava o
    // gows "o peer sumiu" e derrubava a mídia que ACABOU de virar do humano —
    // foi o que matou a ligação no teste de 23/07. Deixar o peer morrer
    // sozinho custa um objeto ocioso por handoff; derrubar a call custa o
    // cliente.
  }

  const ws=new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`,{ headers:{ Authorization:'Bearer '+OPENAI_KEY }});
  let ready=false;
  ws.on('open',()=>{ log('OpenAI WS aberto');
    ws.send(JSON.stringify({ type:'session.update', session:{
      type:'realtime', model:MODEL, output_modalities:['text'],
      audio:{
        input:{ format:{type:'audio/pcm',rate:OAI_RATE}, turn_detection:{type:'server_vad',threshold:0.7,prefix_padding_ms:300,silence_duration_ms:Number(process.env.VAD_SILENCE_MS||1300)},
                transcription:{model:'whisper-1',language:'pt'} }
      },
      tools:[{ type:'function', name:'notificar_pedido',
        description:'Registra e despacha o pedido: envia o resumo do pedido pro entregador/central no WhatsApp. Chame SOMENTE quando o pedido estiver completo e confirmado pelo cliente (produto, endereço e forma de pagamento).',
        parameters:{ type:'object', properties:{
          cliente:{type:'string',description:'Nome do cliente'},
          telefone:{type:'string',description:'Telefone do cliente, se souber'},
          endereco:{type:'string',description:'Rua, número e bairro'},
          referencia:{type:'string',description:'Ponto de referência, se houver'},
          produto:{type:'string',description:'Produto pedido, ex: Botijão P13 Ultragaz (troca)'},
          valor:{type:'string',description:'Valor total EM NÚMEROS, formato R$ 0,00. Ex: R$ 125,00. NUNCA por extenso.'},
          pagamento:{type:'string',description:'Forma de pagamento: dinheiro, Pix, crédito ou débito'},
          troco:{type:'string',description:'Troco para quanto, EM NÚMEROS, se for dinheiro. Ex: R$ 150,00'},
          obs:{type:'string',description:'Observações, se houver'}
        }, required:['produto','endereco','pagamento'] } },
      { type:'function', name:'marcar_sem_venda',
        description:'Registra a ligação quando NÃO vira venda, pra reativação depois. Use ao final quando: o cliente demonstrou interesse mas não fechou (interessado); desistiu de um pedido em andamento (cancelado); ou não quis comprar (nao_quis).',
        parameters:{ type:'object', properties:{
          status:{type:'string',enum:['interessado','cancelado','nao_quis'],description:'interessado = quis saber mas não fechou; cancelado = desistiu de um pedido; nao_quis = não quis comprar'},
          motivo:{type:'string',description:'Motivo curto, se o cliente disse (ex: achou caro, vai comprar depois)'}
        }, required:['status'] } }],
      tool_choice:'auto',
      instructions:PROMPT }}));
  });
  ws.on('message',raw=>{ let m; try{m=JSON.parse(raw)}catch{return;}
    switch(m.type){
      case 'session.updated':
        if(!ready){ ready=true; log('sessão pronta → saudação');
          ws.send(JSON.stringify({type:'response.create'})); }
        break;
      case 'response.created':  lastRespAt=Date.now(); ttsTurn=startTTSTurn(); responding=true; barged=false; bargeUntil=0; loudRun=0; turnBuf=''; turnFull=''; break;
      case 'response.output_text.delta':
      case 'response.text.delta':
        if(m.delta) ttsFeed(m.delta); break;
      case 'response.output_text.done':
      case 'response.text.done':
        if(m.text){ const t=m.text.replace(/\[[^\]]*\]/g,'').trim(); log('🤖 IA:', m.text.trim()); if(t){ const at=lastRespAt||Date.now(); transcript.push({role:'ai',text:t,ts:at}); postLive('line','ai',t,at); } } ttsFinish(); break;
      case 'input_audio_buffer.speech_started': lastSpeechAt=Date.now(); log('[oai] speech_started (cliente falando)'); break;
      case 'input_audio_buffer.committed':      log('[oai] buffer committed → gerando resposta'); break;
      case 'response.done':     responding=false; log('[oai] response.done', (m.response&&m.response.status)||''); if(ttsTurn) ttsTurn.flush(); break;
      case 'conversation.item.input_audio_transcription.completed':
        if(m.transcript){ const t=m.transcript.trim(); log('🗣️ CLIENTE:', t); if(t){ const at=lastSpeechAt||Date.now(); transcript.push({role:'customer',text:t,ts:at}); postLive('line','customer',t,at); } } break;
      case 'response.output_item.added':
        if(m.item && m.item.type==='function_call'){ fnNames[m.item.call_id]=m.item.name; }
        break;
      case 'response.function_call_arguments.done':
        handleTool(fnNames[m.call_id]||m.name, m.call_id, m.arguments); break;
      case 'error':
        log('OpenAI ERR:', JSON.stringify(m.error||m).slice(0,300)); break;
    }
  });
  ws.on('error',e=>log('WS err',e.message));
  ws.on('close',()=>log('OpenAI WS fechado'));

  let rc=0, spoke=0, fc=0, peakR=0;
  dc.onMessage.subscribe(d=>{ const buf=Buffer.isBuffer(d)?d:Buffer.from(d);
    // Escuta: manda a conversa INTEIRA — voz do cliente somada à da IA.
    if(relay.clients.size){
      let out=buf;
      if(aiEcho.length){
        const n=Math.min(buf.length, aiEcho.length);
        const mix=Buffer.from(buf);                       // cópia: `buf` é do gows
        for(let i=0;i+1<n;i+=2){
          let v=mix.readInt16LE(i)+aiEcho.readInt16LE(i);
          if(v>32767)v=32767; else if(v<-32768)v=-32768;  // satura em vez de estourar
          mix.writeInt16LE(v,i);
        }
        aiEcho=aiEcho.subarray(n);
        out=mix;
      }
      relay.fanout(out);
    }
    // Com um atendente no comando, o cérebro sai de cena: não escuta nem responde.
    if(relay.talk) return;
    const r=rms(buf); if(r>300)spoke++;
    if(!aiTalking()){ fc++; if(r>peakR)peakR=r; if(fc%100===0){ log('[rms] pico(2s)='+peakR); peakR=0; } }

    if(aiTalking()){
      // ENQUANTO A IA FALA: nada é mandado pro cérebro. No viva-voz a própria
      // voz dela volta pela caixa do cliente; se a gente encaminhasse, o OpenAI
      // ouviria a IA como se fosse o cliente e ela se perderia (foi o que o Alex
      // viu). O barge-in só CORTA ela localmente — e exige som ALTO E SUSTENTADO
      // (BARGE_FRAMES frames seguidos), pra um estalo/ruído isolado não cortar.
      if(handoffStarted) return;                 // handoff cuida da própria saída
      if(r>ECHO_GATE) loudRun++; else loudRun=0;
      if(loudRun>=BARGE_FRAMES && !barged){
        barged=true; loudRun=0; log('[barge-in] cliente interrompeu → corta a IA');
        aiQ=Buffer.alloc(0); hangupAfterPlay=false;
        if(ttsTurn){ ttsTurn.close(); }
        if(responding){ try{ws.send(JSON.stringify({type:'response.cancel'}))}catch{} }
      }
      return;                                    // nunca encaminha durante a fala da IA
    }
    // IA CALADA: encaminha a voz do cliente pro cérebro.
    loudRun=0;
    if(ws.readyState===WebSocket.OPEN){
      let up=resample(buf,RATE,OAI_RATE);
      // som ABAIXO do piso = ruído de linha → manda SILÊNCIO (zeros), senão o
      // VAD do OpenAI nunca vê silêncio pra fechar o turno (ruído constante) e a
      // IA fica muda.
      if(r < NOISE_FLOOR) up = Buffer.alloc(up.length);
      ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:up.toString('base64')}));
    }
  });
  dc.stateChanged.subscribe(s=>{ log('dc:',s); if(s==='closed'||s==='closing'){
    // Num HANDOFF isto é ESPERADO: o gows trocou o transporte pro humano. A
    // ligação continua — viva, com ele. Só encerramos o nosso lado (cérebro +
    // timers) e NUNCA tocamos no pc: fechá-lo derrubaria a mídia do humano.
    if(handoffStarted){ log('dc fechado pelo handoff (humano assumiu) — não encosto no pc'); clearInterval(drainer); if(handoffPoll)clearInterval(handoffPoll); try{ws.close()}catch{}; doRelease(); return; }
    postTranscript(); if(!posted2){posted2=true;postLive('end');} clearInterval(drainer); if(handoffPoll)clearInterval(handoffPoll); unregisterRelay(); try{ws.close()}catch{}; try{pc.close()}catch{}; log(`fim — IA tocou ${(iaPlayed/RATE/2).toFixed(1)}s, cliente falou ~${spoke} frames`); } });
  pc.connectionStateChange.subscribe(s=>{ if((s==='failed'||s==='disconnected') && !handoffStarted){ clearInterval(drainer); if(handoffPoll)clearInterval(handoffPoll); try{ws.close()}catch{}; } });

  await pc.setLocalDescription(await pc.createOffer());
  if(pc.iceGatheringState!=='complete'){ await new Promise(r=>pc.iceGatheringStateChange.subscribe(s=>{if(s==='complete')r();})); }
  const wr=await apiPost(session,`calls/${encodeURIComponent(cid)}/webrtc`,{ sdpOffer: pc.localDescription.sdp });
  let ans={}; try{ans=JSON.parse(wr.body)}catch{}
  if(!ans.sdpAnswer){ log('SEM sdpAnswer',wr.st,wr.body.slice(0,150));
    // Aqui o WS do OpenAI JÁ está aberto: sem esta limpeza ele gera a saudação,
    // posta linha "ao vivo" e deixa selo fantasma + sessão paga vazando.
    clearInterval(drainer); if(handoffPoll)clearInterval(handoffPoll);
    unregisterRelay(); try{ws.close()}catch{}; try{pc.close()}catch{};
    postLive('end');                     // derruba selo se alguma linha vazou
    return; }
  await pc.setRemoteDescription({ type:'answer', sdp: ans.sdpAnswer });
  log('conectado ✓');
  postLive('start');
  // HANDOFF: enquanto a call está viva, checa se um humano clicou "Assumir".
  handoffPoll=setInterval(async ()=>{
    if(handoffStarted) return;
    if(await checkHandoff(cid)) doHandoff();
  }, HANDOFF_POLL_MS);
}

// ---- servidor de RELAY (WebSocket) ----------------------------------------
// O navegador do atendente/supervisor conecta aqui e troca PCM cru 16 kHz s16le
// — o MESMO formato do DataChannel, então não há transcodificação no caminho.
//
// Bilhete assinado (o CRM emite, este processo confere sozinho — sem ida e
// volta): ?callId=..&mode=listen|talk&exp=<epoch ms>&sig=<hmac>
// A assinatura cobre o MODO também, senão um bilhete de escuta viraria um de
// fala só editando a URL.
const WS_PORT=Number(process.env.V2_WS_PORT||3998);  // 3999=waha, 3997=bridge v1 (Maria), 3996=este
function ticketOk(callId, mode, exp, sig){
  if(!BRIDGE_TOKEN || !callId || !sig) return false;
  if(!exp || Date.now() > Number(exp)) return false;              // expirado
  if(mode!=='listen' && mode!=='talk') return false;
  const want=crypto.createHmac('sha256', BRIDGE_TOKEN).update(`${callId}.${mode}.${exp}`).digest('hex');
  const a=Buffer.from(want), b=Buffer.from(String(sig));
  return a.length===b.length && crypto.timingSafeEqual(a,b);
}

// Endereço de escuta: NUNCA 0.0.0.0. Este VPS não tem firewall, e o container
// de voz usa a rede do HOST — escutar em 0.0.0.0 publica o relay na internet em
// ws:// puro (áudio de cliente sem criptografia). O padrão é loopback; em
// produção sobe amarrado ao gateway PRIVADO da rede docker do CRM
// (V2_WS_HOST=10.0.1.1), que o Traefik alcança e a internet não — o TLS fica
// por conta do Traefik (wss://).
const WS_HOST=process.env.V2_WS_HOST||'127.0.0.1';
const wss=new WebSocket.Server({ port: WS_PORT, host: WS_HOST });
wss.on('connection',(ws,req)=>{
  let q={};
  try{ q=Object.fromEntries(new URL(req.url,'http://x').searchParams); }catch{}
  const { callId='', mode='listen', exp='', sig='' } = q;
  if(!ticketOk(callId, mode, exp, sig)){ log('[relay] bilhete inválido — recuso'); try{ws.close(4001,'unauthorized')}catch{}; return; }
  const relay=liveCalls.get(callId);
  if(!relay){ log('[relay] ligação',callId,'não está viva — recuso'); try{ws.close(4004,'no such call')}catch{}; return; }

  const client={ ws, mode };
  relay.clients.add(client);
  log(`[relay] ${mode==='talk'?'ATENDENTE assumiu':'supervisor ouvindo'} a ligação ${callId} (${relay.clients.size} conectado(s))`);

  // Voz do atendente → ligação. Em 'listen' o que ele mandar é ignorado, para
  // que um ouvinte jamais entre no áudio do cliente por engano.
  ws.on('message',d=>{ if(client.mode!=='talk') return;
    const buf=Buffer.isBuffer(d)?d:Buffer.from(d); if(buf.length) relay.toCall(buf); });
  ws.on('close',()=>{ relay.clients.delete(client);
    log(`[relay] saiu (${mode}) da ligação ${callId} — restam ${relay.clients.size}`); });
  ws.on('error',e=>{ relay.clients.delete(client); log('[relay] erro:',e.message); });
});
wss.on('error',e=>log('[relay] servidor erro:',e.message));

const srv=http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{r.writeHead(200);r.end('ok');let d={};try{d=JSON.parse(b)}catch{};
  if(d.event==='call.received'){ const session=d.session||'default'; handleCall((d.payload||{}).id, session, d.payload||{}).catch(e=>log('handleCall err',e.message)); } });});
srv.listen(PORT,'127.0.0.1',()=>{ log('IA voz v2 ouvindo :'+PORT+' | relay ws '+WS_HOST+':'+WS_PORT+' | CRM='+CRM_BASE+(CHANNEL_OVERRIDE?(' | OVERRIDE canal '+CHANNEL_OVERRIDE.slice(0,8)):'')+(BRIDGE_TOKEN?'':' [SEM BRIDGE_TOKEN!]'));
  // self-test da leitura de config no boot
  fetchConfig('boot').then(c=>{ if(!c){ log('[selftest] config NULA (endpoint/token?)'); return; }
    log('[selftest] found='+c.found+' enabled='+c.enabled+' canal='+(c.channelName||'-')+' voz='+(c.voiceId||'-')
      +' elevenKey='+(c.elevenlabsKey?c.elevenlabsKey.length+'ch':'FALTA')+' openaiKey='+(c.openaiKey?c.openaiKey.length+'ch':'FALTA')); });
});
