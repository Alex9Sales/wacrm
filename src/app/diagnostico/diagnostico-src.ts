// Gerado do diagnostico. Documento servido via <iframe srcDoc> em /diagnostico.
export const DIAGNOSTICO_HTML = `<!doctype html>
<html lang="pt-BR">
<title>Diagnóstico Fluxia</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Inter:wght@400;500;600;700&display=swap" />

<style>
  /* ==========================================================
     Diagnostico Fluxia: quiz de qualificacao para o FluxiaCRM.
     Tema escuro comprometido (a identidade da Fluxia e dark + violeta);
     todas as cores pintadas por token. Zero em-dash na copy visivel.
     ========================================================== */
  :root {
    color-scheme: dark;
    --bg: #0b0912;
    --bg-2: #100d1a;
    --surface: #15111f;
    --surface-2: #1b1628;
    --border: #2a2340;
    --border-soft: #221c34;
    --text: #f4f1fb;
    --text-dim: #b7b0cc;
    --text-mute: #968ea8;
    /* Acento unico: violeta Fluxia (oklch 0.526 0.247 293) */
    --violet: #7c4dff;
    --violet-bright: #9d7bff;
    --violet-soft: #b9a4ff;
    --violet-deep: #5b34d6;
    /* Sinais semanticos (usados so como sinal, nunca decorativo) */
    --risk: #ff8a6b;
    --ok: #57d9a8;
    /* Escala unica de raio de canto */
    --r-xs: 8px;
    --r-sm: 12px;
    --r-md: 16px;
    --r-lg: 20px;
    --r-pill: 999px;
    --ease: cubic-bezier(0.16, 1, 0.3, 1);
    --maxw: 1180px;
    --fs-display: clamp(2.5rem, 7vw, 4.75rem);
    --fs-q: clamp(1.6rem, 4.6vw, 2.75rem);
    --font-display: "Bricolage Grotesque", "Inter", system-ui, sans-serif;
    --font-body: "Inter", system-ui, -apple-system, sans-serif;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { -webkit-text-size-adjust: 100%; }

  body {
    font-family: var(--font-body);
    background: var(--bg);
    color: var(--text);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    min-height: 100dvh;
    overflow-x: hidden;
    position: relative;
  }

  /* ---- Fundo: telas reais do CRM (mini-funil) desfocadas + aurora violeta ---- */
  .crm-bg {
    position: fixed;
    inset: -6% -4% auto -4%;
    top: -3%;
    height: 82vh;
    z-index: 0;
    pointer-events: none;
    display: flex;
    gap: 14px;
    padding: 0 4vw;
    transform: perspective(1600px) rotateX(15deg) rotateZ(-6deg) scale(1.06);
    transform-origin: top center;
    filter: blur(3.5px) saturate(1.12) brightness(0.92);
    opacity: 0.82;
    -webkit-mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,0.7) 48%, transparent 86%);
            mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,0.7) 48%, transparent 86%);
  }
  .crm-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .crm-colhead { display: flex; align-items: center; justify-content: space-between; padding: 0 2px 2px; }
  .crm-colhead .nm { font-size: 12px; font-weight: 600; color: var(--text-dim); }
  .crm-colhead .ct { font-size: 11px; color: var(--text-mute); background: var(--surface-2); border-radius: var(--r-pill); padding: 1px 7px; }
  .crm-topbar { height: 3px; border-radius: var(--r-pill); margin-bottom: 8px; }
  .crm-card {
    background: linear-gradient(180deg, var(--surface-2), var(--surface));
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 11px 12px;
  }
  .crm-card .t { font-size: 12.5px; font-weight: 600; color: var(--text); line-height: 1.25; }
  .crm-card .c { font-size: 11px; color: var(--text-mute); margin-top: 5px; display: flex; align-items: center; gap: 5px; }
  .crm-card .v { font-size: 13px; font-weight: 700; color: var(--violet-soft); margin-top: 8px; }
  .crm-avatar { width: 15px; height: 15px; border-radius: var(--r-pill); background: var(--violet-deep); flex: none; }

  .bg-aura {
    position: fixed; inset: 0; z-index: 1; pointer-events: none;
    background:
      radial-gradient(58% 50% at 82% 8%, rgba(124, 77, 255, 0.24), transparent 60%),
      radial-gradient(52% 52% at 10% 92%, rgba(91, 52, 214, 0.22), transparent 62%),
      /* deixa o CRM aparecer no topo, mas cria um veu escuro atras do titulo
         pra o texto manter contraste, e fecha em bg embaixo */
      linear-gradient(180deg, rgba(11,9,18,0) 7%, rgba(11,9,18,0.5) 30%, rgba(11,9,18,0.82) 58%, var(--bg) 84%);
  }
  .bg-noise {
    position: fixed; inset: 0; z-index: 1; pointer-events: none; opacity: 0.03;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }

  .stage {
    position: relative; z-index: 2;
    min-height: 100dvh;
    display: flex; flex-direction: column;
    max-width: var(--maxw); margin: 0 auto;
    padding: clamp(1.25rem, 3vw, 2rem);
    padding-bottom: max(1.5rem, env(safe-area-inset-bottom));
  }

  .topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .brand { display: flex; align-items: center; gap: 0.6rem; }
  .brand-mark {
    width: 34px; height: 34px; border-radius: var(--r-xs);
    background: linear-gradient(145deg, var(--violet-bright), var(--violet-deep));
    display: grid; place-items: center; flex: none;
    box-shadow: 0 4px 14px -4px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.22);
  }
  .brand-mark svg { width: 18px; height: 18px; }
  .brand-name { font-family: var(--font-display); font-weight: 700; font-size: 1.05rem; letter-spacing: -0.01em; }
  .brand-name b { color: var(--violet-soft); font-weight: 700; }

  .progress-wrap { margin-top: 1.1rem; height: 4px; border-radius: var(--r-pill); background: var(--border-soft); overflow: hidden; }
  .progress-bar {
    height: 100%; width: 0%; border-radius: var(--r-pill);
    background: linear-gradient(90deg, var(--violet-deep), var(--violet-bright));
    transition: width 0.6s var(--ease);
  }

  .screen-host { flex: 1; display: flex; align-items: center; padding: clamp(1.5rem, 4vh, 3rem) 0; }
  .screen { width: 100%; }
  .screen[hidden] { display: none; }

  .anim-in { animation: rise 0.5s var(--ease) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: none; } }

  .eyebrow {
    display: inline-flex; align-items: center; gap: 0.5rem;
    font-size: 0.76rem; font-weight: 600; letter-spacing: 0.02em;
    color: var(--violet-soft);
    background: rgba(124, 77, 255, 0.1);
    border: 1px solid rgba(124, 77, 255, 0.25);
    padding: 0.4rem 0.8rem; border-radius: var(--r-pill);
  }
  .eyebrow .dot { width: 6px; height: 6px; border-radius: var(--r-pill); background: var(--violet-bright); }

  .hero { display: grid; grid-template-columns: 1fr; gap: clamp(2rem, 5vw, 4rem); align-items: center; }
  @media (min-width: 940px) { .hero { grid-template-columns: 1.05fr 0.95fr; } }

  h1.display {
    font-family: var(--font-display); font-weight: 700;
    font-size: var(--fs-display); line-height: 0.98; letter-spacing: -0.03em;
    margin-top: 1.3rem; text-wrap: balance;
  }
  h1.display .hl { color: var(--violet-soft); font-style: italic; padding-bottom: 0.06em; }
  .hero p.sub { margin-top: 1.3rem; font-size: clamp(1.02rem, 2vw, 1.2rem); color: var(--text-dim); max-width: 34ch; }
  .hero-cta { margin-top: 2rem; display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; }

  /* Painel "antes": a caixa de WhatsApp do jeito que costuma ser */
  .glass {
    position: relative; border-radius: var(--r-lg);
    background: linear-gradient(180deg, rgba(27, 22, 40, 0.9), rgba(17, 13, 26, 0.92));
    border: 1px solid var(--border);
    box-shadow: 0 30px 70px -34px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.05);
    padding: 1.15rem; backdrop-filter: blur(12px);
  }
  .glass-head { display: flex; align-items: center; gap: 0.55rem; padding-bottom: 0.9rem; border-bottom: 1px solid var(--border-soft); }
  .glass-head .tt { font-size: 0.82rem; color: var(--text-mute); }
  .glass-dot { width: 9px; height: 9px; border-radius: var(--r-pill); background: var(--risk); }
  .chat-row { display: flex; gap: 0.6rem; padding: 0.8rem 0; align-items: flex-start; }
  .chat-row + .chat-row { border-top: 1px solid var(--border-soft); }
  .av { width: 30px; height: 30px; border-radius: var(--r-pill); flex: none; display: grid; place-items: center; font-size: 0.72rem; font-weight: 700; color: #fff; background: linear-gradient(135deg, var(--violet), var(--violet-deep)); }
  .av.n2 { background: linear-gradient(135deg, #6d6a86, #46435c); }
  .av.n3 { background: linear-gradient(135deg, #8a6bd6, #4a3a86); }
  .chat-b { min-width: 0; }
  .chat-b .nm { font-size: 0.82rem; font-weight: 600; display: flex; align-items: center; gap: 0.4rem; }
  .chat-b .msg { font-size: 0.82rem; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag-miss { font-size: 0.64rem; font-weight: 600; color: var(--risk); background: rgba(255, 138, 107, 0.12); border: 1px solid rgba(255, 138, 107, 0.3); padding: 0.05rem 0.4rem; border-radius: var(--r-xs); }
  .tag-time { font-size: 0.7rem; color: var(--text-mute); margin-left: auto; flex: none; font-variant-numeric: tabular-nums; }

  .btn {
    font-family: var(--font-body); font-size: 0.98rem; font-weight: 600;
    border: none; cursor: pointer; border-radius: var(--r-pill);
    padding: 0.95rem 1.6rem;
    display: inline-flex; align-items: center; justify-content: center; gap: 0.55rem;
    transition: transform 0.15s var(--ease), background 0.2s, box-shadow 0.2s, border-color 0.2s;
    white-space: nowrap;
  }
  .btn:active { transform: translateY(1px) scale(0.99); }
  .btn:focus-visible { outline: 2px solid var(--violet-bright); outline-offset: 3px; }
  .btn-primary {
    background: linear-gradient(180deg, var(--violet-bright), var(--violet));
    color: #fff;
    box-shadow: 0 10px 26px -12px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.28);
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 16px 34px -14px rgba(0,0,0,0.75); }
  .btn-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--border); }
  .btn-ghost:hover { border-color: var(--violet); color: var(--text); }
  .btn svg { width: 18px; height: 18px; }
  .btn-lg { padding: 1.05rem 2rem; font-size: 1.05rem; }

  .q-head { max-width: 40ch; }
  .q-count { font-size: 0.8rem; font-weight: 600; color: var(--violet-soft); letter-spacing: 0.02em; }
  h2.q { font-family: var(--font-display); font-weight: 700; font-size: var(--fs-q); line-height: 1.05; letter-spacing: -0.02em; margin-top: 0.7rem; text-wrap: balance; }
  h2.q:focus-visible { outline: none; }
  .q-hint { margin-top: 0.6rem; color: var(--text-mute); font-size: 0.92rem; }

  .options { margin-top: 1.9rem; display: grid; gap: 0.7rem; max-width: 620px; }
  .opt {
    text-align: left; cursor: pointer;
    display: flex; align-items: center; gap: 0.9rem;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-md);
    padding: 1.05rem 1.15rem; color: var(--text);
    font-size: 1.02rem; font-weight: 500; font-family: var(--font-body);
    transition: border-color 0.18s, background 0.18s, transform 0.12s var(--ease);
  }
  .opt:hover { border-color: var(--violet); background: var(--surface-2); transform: translateX(3px); }
  .opt:focus-visible { outline: 2px solid var(--violet-bright); outline-offset: 2px; }
  .opt .mk {
    width: 26px; height: 26px; flex: none; border-radius: var(--r-xs);
    border: 1.5px solid var(--border); display: grid; place-items: center;
    color: var(--text-mute); font-size: 0.8rem; font-weight: 700; transition: all 0.18s;
  }
  .opt:hover .mk { border-color: var(--violet); color: var(--violet-soft); }
  .opt[aria-checked="true"] { border-color: var(--violet); background: rgba(124, 77, 255, 0.12); }
  .opt[aria-checked="true"] .mk { background: var(--violet); border-color: var(--violet); color: #fff; }

  .q-nav { margin-top: 1.8rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem 1rem; }
  .back-link {
    background: none; border: none; cursor: pointer; color: var(--text-mute);
    font-family: var(--font-body); font-size: 0.92rem;
    display: inline-flex; align-items: center; gap: 0.4rem;
    min-height: 44px; padding: 0.4rem 0.5rem; border-radius: var(--r-xs);
  }
  .back-link:hover { color: var(--text); }
  .back-link:focus-visible { outline: 2px solid var(--violet-bright); outline-offset: 2px; }
  .back-link svg { width: 16px; height: 16px; }

  .form-grid { margin-top: 1.9rem; display: grid; gap: 1.1rem; max-width: 520px; }
  .field { display: grid; gap: 0.5rem; }
  .field label { font-size: 0.86rem; font-weight: 600; color: var(--text-dim); }
  .field input, .field select {
    font-family: var(--font-body); font-size: 1rem;
    background: var(--surface); color: var(--text);
    border: 1px solid var(--border); border-radius: var(--r-sm);
    padding: 0.95rem 1rem; width: 100%;
    transition: border-color 0.18s, box-shadow 0.18s;
  }
  .field input::placeholder { color: var(--text-mute); }
  .field input:focus, .field select:focus { outline: none; border-color: var(--violet-bright); box-shadow: 0 0 0 3px rgba(157, 123, 255, 0.5); }
  .field input[aria-invalid="true"], .field select[aria-invalid="true"] { border-color: var(--risk); }
  .field .err { font-size: 0.8rem; color: var(--risk); min-height: 1em; }
  .consent { display: flex; gap: 0.6rem; align-items: flex-start; font-size: 0.82rem; color: var(--text-mute); }
  .consent input { margin-top: 0.2rem; width: 18px; height: 18px; accent-color: var(--violet); flex: none; }
  .consent-err { font-size: 0.8rem; color: var(--risk); min-height: 1em; margin-top: -0.4rem; }

  .result { display: grid; grid-template-columns: 1fr; gap: clamp(1.6rem, 4vw, 2.6rem); align-items: start; }
  @media (min-width: 900px) { .result { grid-template-columns: 0.85fr 1.15fr; } }
  .gauge-card {
    background: linear-gradient(180deg, var(--surface-2), var(--surface));
    border: 1px solid var(--border); border-radius: var(--r-lg);
    padding: 1.6rem; text-align: center;
    box-shadow: 0 24px 60px -34px rgba(0,0,0,0.85);
  }
  .gauge { position: relative; width: 200px; height: 200px; margin: 0.4rem auto 0.8rem; }
  .gauge svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  .gauge .track { fill: none; stroke: var(--border-soft); stroke-width: 14; }
  .gauge .val { fill: none; stroke: url(#gaugeGrad); stroke-width: 14; stroke-linecap: round; transition: stroke-dashoffset 1.4s var(--ease); }
  .gauge-center { position: absolute; inset: 0; display: grid; place-content: center; gap: 0.1rem; }
  .gauge-num { font-family: var(--font-display); font-weight: 700; font-size: 3.2rem; line-height: 1; font-variant-numeric: tabular-nums; }
  .gauge-lbl { font-size: 0.74rem; color: var(--text-mute); letter-spacing: 0.06em; text-transform: uppercase; }
  .risk-pill { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.86rem; font-weight: 600; padding: 0.4rem 0.9rem; border-radius: var(--r-pill); }

  .result h2.rt { font-family: var(--font-display); font-weight: 700; font-size: clamp(1.8rem, 4.5vw, 2.8rem); line-height: 1.03; letter-spacing: -0.02em; text-wrap: balance; }
  .result .lead { margin-top: 0.9rem; color: var(--text-dim); font-size: 1.05rem; max-width: 52ch; }
  .fix-list { margin-top: 1.5rem; display: grid; gap: 0.7rem; }
  .fix { display: flex; gap: 0.85rem; align-items: flex-start; background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--r-sm); padding: 0.9rem 1rem; }
  .fix .ic { width: 34px; height: 34px; flex: none; border-radius: var(--r-xs); background: rgba(124, 77, 255, 0.14); display: grid; place-items: center; color: var(--violet-soft); }
  .fix .ic svg { width: 18px; height: 18px; }
  .fix .ft { font-weight: 600; font-size: 0.96rem; }
  .fix .fd { font-size: 0.86rem; color: var(--text-mute); margin-top: 0.1rem; }
  .confirm { margin-top: 1.1rem; display: flex; align-items: flex-start; gap: 0.6rem; font-size: 0.92rem; color: var(--text-dim); background: rgba(87,217,168,0.1); border: 1px solid rgba(87,217,168,0.28); border-radius: var(--r-sm); padding: 0.75rem 0.9rem; }
  .confirm svg { width: 18px; height: 18px; color: var(--ok); flex: none; margin-top: 1px; }
  .steps { margin-top: 1.6rem; }
  .steps .st-title { font-size: 0.82rem; font-weight: 600; color: var(--violet-soft); letter-spacing: 0.02em; margin-bottom: 0.8rem; }
  .step { display: flex; align-items: center; gap: 0.7rem; padding: 0.32rem 0; font-size: 0.95rem; color: var(--text-dim); }
  .step .sn { width: 24px; height: 24px; flex: none; border-radius: var(--r-pill); background: rgba(124,77,255,0.16); color: var(--violet-soft); font-size: 0.8rem; font-weight: 700; display: grid; place-items: center; }
  .result-cta { margin-top: 1.8rem; display: flex; flex-wrap: wrap; gap: 0.9rem; }
  .fineprint { margin-top: 1.1rem; font-size: 0.8rem; color: var(--text-mute); }

  .spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: var(--r-pill); animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    *, .anim-in { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    .crm-bg { transform: none; }
  }
</style>

<!-- Fundo: mini-funil real do CRM, desfocado (atmosfera de produto) -->
<div class="crm-bg" aria-hidden="true">
  <div class="crm-col">
    <div class="crm-topbar" style="background:#57d9a8"></div>
    <div class="crm-colhead"><span class="nm">Novo lead</span><span class="ct">3</span></div>
    <div class="crm-card"><div class="t">Orçamento botijão P13</div><div class="c"><span class="crm-avatar"></span>Marcos, Vila Nova</div><div class="v">R$ 320</div></div>
    <div class="crm-card"><div class="t">Recarga água 20L</div><div class="c"><span class="crm-avatar"></span>Condomínio Aroeira</div><div class="v">R$ 180</div></div>
  </div>
  <div class="crm-col">
    <div class="crm-topbar" style="background:#9d7bff"></div>
    <div class="crm-colhead"><span class="nm">Em negociação</span><span class="ct">2</span></div>
    <div class="crm-card"><div class="t">Contrato mensal gás</div><div class="c"><span class="crm-avatar"></span>Padaria do Zé</div><div class="v">R$ 1.240</div></div>
    <div class="crm-card"><div class="t">Combo 3 botijões</div><div class="c"><span class="crm-avatar"></span>Renata Souza</div><div class="v">R$ 870</div></div>
  </div>
  <div class="crm-col">
    <div class="crm-topbar" style="background:#7c4dff"></div>
    <div class="crm-colhead"><span class="nm">Fechado</span><span class="ct">4</span></div>
    <div class="crm-card"><div class="t">Entrega recorrente</div><div class="c"><span class="crm-avatar"></span>Mercado São João</div><div class="v">R$ 2.100</div></div>
    <div class="crm-card"><div class="t">Venda avulsa</div><div class="c"><span class="crm-avatar"></span>Ana Paula</div><div class="v">R$ 95</div></div>
  </div>
</div>
<div class="bg-aura" aria-hidden="true"></div>
<div class="bg-noise" aria-hidden="true"></div>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5b34d6" />
      <stop offset="100%" stop-color="#9d7bff" />
    </linearGradient>
  </defs>
</svg>

<main class="stage">
  <div class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H9l-4 4v-4H6.5" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>
      </span>
      <span class="brand-name">Fluxia<b>CRM</b></span>
    </div>
  </div>

  <div class="progress-wrap" id="progressWrap" hidden role="progressbar" aria-label="Progresso do diagnóstico" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
    <div class="progress-bar" id="progressBar"></div>
  </div>

  <div class="screen-host">

    <!-- INTRO -->
    <section class="screen anim-in" id="screen-intro">
      <div class="hero">
        <div>
          <span class="eyebrow"><span class="dot"></span>Diagnóstico gratuito, leva 1 minuto</span>
          <h1 class="display">Quantas vendas<br>somem no seu <span class="hl">WhatsApp?</span></h1>
          <p class="sub">Responda 8 perguntas rápidas e veja onde o seu atendimento perde cliente, e o que dá pra arrumar.</p>
          <div class="hero-cta">
            <button class="btn btn-primary btn-lg" id="startBtn">
              Começar diagnóstico
              <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>

        <aside class="glass" aria-hidden="true">
          <div class="glass-head">
            <span class="glass-dot"></span>
            <span class="tt">Do jeito que costuma ser hoje</span>
          </div>
          <div class="chat-row">
            <span class="av">MC</span>
            <div class="chat-b">
              <span class="nm">Marcos, orçamento</span>
              <span class="msg">"Ainda tá de pé o preço?"</span>
            </div>
            <span class="tag-time">3 dias</span>
          </div>
          <div class="chat-row">
            <span class="av n2">RS</span>
            <div class="chat-b">
              <span class="nm">Renata Souza <span class="tag-miss">sem resposta</span></span>
              <span class="msg">"Bom dia, consigo pra hoje?"</span>
            </div>
            <span class="tag-time">18h</span>
          </div>
          <div class="chat-row">
            <span class="av n3">JP</span>
            <div class="chat-b">
              <span class="nm">João Paulo <span class="tag-miss">esfriou</span></span>
              <span class="msg">Ficou de fechar semana passada</span>
            </div>
            <span class="tag-time">6 dias</span>
          </div>
        </aside>
      </div>
    </section>

    <!-- PERGUNTA -->
    <section class="screen" id="screen-q" hidden>
      <div class="q-head">
        <span class="q-count" id="qCount">Pergunta 1 de 8</span>
        <h2 class="q" id="qTitle" tabindex="-1"></h2>
        <p class="q-hint" id="qHint" hidden></p>
      </div>
      <div class="options" id="qOptions" role="radiogroup" aria-labelledby="qTitle"></div>
      <div class="q-nav">
        <button class="back-link" id="backBtn" type="button">
          <svg viewBox="0 0 24 24" fill="none"><path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Voltar
        </button>
      </div>
    </section>

    <!-- CONTATO -->
    <section class="screen" id="screen-contact" hidden>
      <div class="q-head">
        <span class="q-count">Falta pouco</span>
        <h2 class="q">Pra onde enviamos o seu diagnóstico?</h2>
        <p class="q-hint">Seu resultado já está pronto. Deixe o contato pra receber e falar com a gente.</p>
      </div>
      <form class="form-grid" id="contactForm" novalidate>
        <div aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden">
          <label for="f-site">Não preencha este campo</label>
          <input id="f-site" name="site" type="text" tabindex="-1" autocomplete="off" />
        </div>
        <div class="field">
          <label for="f-nome">Seu nome</label>
          <input id="f-nome" name="nome" type="text" autocomplete="name" placeholder="Ex.: Marcos Silva" aria-describedby="err-nome" />
          <span class="err" id="err-nome" role="alert"></span>
        </div>
        <div class="field">
          <label for="f-wpp">WhatsApp (com DDD)</label>
          <input id="f-wpp" name="whatsapp" type="tel" inputmode="numeric" autocomplete="tel" placeholder="(67) 99999-9999" aria-describedby="err-wpp" />
          <span class="err" id="err-wpp" role="alert"></span>
        </div>
        <div class="field">
          <label for="f-email">Seu melhor e-mail</label>
          <input id="f-email" name="email" type="email" autocomplete="email" placeholder="voce@empresa.com" aria-describedby="err-email" />
          <span class="err" id="err-email" role="alert"></span>
        </div>
        <div class="field">
          <label for="f-seg">O que a sua empresa faz?</label>
          <select id="f-seg" name="segmento" aria-describedby="err-seg">
            <option value="">Escolha uma opção</option>
            <option>Revenda de gás e água</option>
            <option>Comércio ou loja</option>
            <option>Serviços</option>
            <option>Saúde ou clínica</option>
            <option>Beleza ou estética</option>
            <option>Educação ou cursos</option>
            <option>Imobiliária</option>
            <option>Outro</option>
          </select>
          <span class="err" id="err-seg" role="alert"></span>
        </div>
        <div>
          <label class="consent">
            <input type="checkbox" id="f-ok" aria-describedby="err-ok" />
            <span>Aceito receber meu diagnóstico e um contato da FluxiaCRM no WhatsApp.</span>
          </label>
          <div class="consent-err" id="err-ok" role="alert"></div>
        </div>
        <div class="q-nav" style="margin-top:0.2rem">
          <button type="submit" class="btn btn-primary btn-lg" id="submitBtn">
            Ver meu diagnóstico
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="back-link" id="backBtnContact">
            <svg viewBox="0 0 24 24" fill="none"><path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Voltar
          </button>
        </div>
      </form>
    </section>

    <!-- RESULTADO -->
    <section class="screen" id="screen-result" hidden>
      <div class="result">
        <div class="gauge-card">
          <div class="gauge">
            <svg viewBox="0 0 200 200" aria-hidden="true">
              <circle class="track" cx="100" cy="100" r="84" />
              <circle class="val" id="gaugeVal" cx="100" cy="100" r="84" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" />
            </svg>
            <div class="gauge-center">
              <span class="gauge-num" id="gaugeNum">0</span>
              <span class="gauge-lbl">de 100</span>
            </div>
          </div>
          <span class="risk-pill" id="riskPill"></span>
          <p style="margin-top:0.9rem;font-size:0.86rem;color:var(--text-mute)">Índice de vazamento do seu atendimento</p>
        </div>

        <div>
          <span class="q-count" id="resGreet"></span>
          <h2 class="rt" id="resTitle"></h2>
          <p class="lead" id="resLead"></p>
          <div class="confirm">
            <svg viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span id="resConfirm">Recebemos seus dados. Um especialista da Fluxia vai te chamar no WhatsApp.</span>
          </div>
          <div class="fix-list" id="fixList"></div>
          <div class="steps">
            <div class="st-title">O que acontece agora</div>
            <div class="step"><span class="sn">1</span> Você testa o FluxiaCRM grátis por 7 dias, sem cartão.</div>
            <div class="step"><span class="sn">2</span> A gente te ajuda a montar tudo, no seu ritmo.</div>
            <div class="step"><span class="sn">3</span> Seu WhatsApp organizado, sem lead escapando.</div>
          </div>
          <div class="result-cta">
            <a class="btn btn-primary btn-lg" id="ctaTrial" href="#" target="_top" rel="noopener">
              Testar o FluxiaCRM 7 dias grátis
              <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </a>
            <a class="btn btn-ghost btn-lg" id="ctaWpp" href="#" target="_top" rel="noopener">Falar com um especialista</a>
          </div>
          <p class="fineprint">Sem cartão pra testar. E do outro lado tem gente de verdade pra te ajudar a montar tudo.</p>
        </div>
      </div>
    </section>

  </div>
</main>

<script>
(function () {
  "use strict";

  // Cada pergunta: w = peso de vazamento; scored = entra no indice.
  // Perguntas de ESCALA (nº de pessoas / nº de números) so roteiam a
  // recomendacao, nao contam como "perda" (senao seria impossivel zerar).
  var QUESTIONS = [
    { scored: false, q: "Quantas pessoas respondem o WhatsApp da empresa?", hint: "Vale contar todo mundo que fala com cliente.",
      opts: [ { t: "Só eu", w: 0 }, { t: "De 2 a 4 pessoas", w: 3 }, { t: "5 ou mais", w: 3 }, { t: "Ninguém fixo, cada hora é um", w: 3 } ] },
    { scored: true, q: "Onde ficam seus clientes e conversas hoje?",
      opts: [ { t: "Num CRM de verdade", w: 0 }, { t: "Planilha ou caderno", w: 2 }, { t: "Nos grupos e conversas do WhatsApp", w: 3 }, { t: "Na memória mesmo", w: 3 } ] },
    { scored: true, q: "Com que frequência um lead some sem resposta?",
      opts: [ { t: "Quase todo dia", w: 3 }, { t: "Toda semana", w: 2 }, { t: "De vez em quando", w: 1 }, { t: "Quase nunca", w: 0 } ] },
    { scored: true, q: "Você sabe de onde veio cada cliente?", hint: "Anúncio, indicação, Instagram, site.",
      opts: [ { t: "Sei de todos, fica registrado", w: 0 }, { t: "Mais ou menos", w: 2 }, { t: "Não faço ideia", w: 3 } ] },
    { scored: true, q: "E o follow-up, quem não respondeu recebe retorno?",
      opts: [ { t: "Sim, o sistema lembra e cobra", w: 0 }, { t: "Manual, quando eu lembro", w: 2 }, { t: "Não faço follow-up", w: 3 } ] },
    { scored: false, q: "Quantos números de WhatsApp a empresa usa?",
      opts: [ { t: "Um só", w: 0 }, { t: "De 2 a 3", w: 2 }, { t: "4 ou mais", w: 3 } ] },
    { scored: true, q: "Você tem relatório de quanto vende e quem converte?",
      opts: [ { t: "Sim, acompanho de perto", w: 0 }, { t: "Só no achismo", w: 2 }, { t: "Nenhum controle", w: 3 } ] },
    { scored: true, q: "Fora do horário comercial, quem responde seus clientes?",
      opts: [ { t: "Tenho atendimento que cobre 24h", w: 0 }, { t: "Eu mesmo, quando vejo", w: 2 }, { t: "Ninguém, fica pra amanhã", w: 3 } ] }
  ];

  var MAX = QUESTIONS.reduce(function (s, q) {
    if (!q.scored) return s;
    return s + Math.max.apply(null, q.opts.map(function (o) { return o.w; }));
  }, 0);

  var FIXES = {
    inbox: { t: "Caixa de entrada compartilhada", d: "Todo o time e todos os números num lugar. Ninguém responde por cima do outro.", ic: "inbox" },
    funil: { t: "Funil de vendas", d: "Cada cliente numa etapa. Você vê quem está pra fechar e quem parou.", ic: "funnel" },
    followup: { t: "Follow-up e cadência automáticos", d: "O sistema cobra quem sumiu, no horário certo, sem você lembrar.", ic: "clock" },
    origem: { t: "Origem do lead e relatórios", d: "Descubra o que traz venda e quem converte. Chega de achismo.", ic: "chart" },
    ia: { t: "Agente de IA 24h", d: "Responde e qualifica sozinho, no seu tom, também fora do horário.", ic: "bot" }
  };

  var ICONS = {
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.5 5h13l3.5 7v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-5l3.5-7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    funnel: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    clock: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    chart: '<path d="M4 4v16h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 14l3-3 3 2 4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 8V4M9 13h.01M15 13h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  };

  var state = { step: -1, answers: new Array(QUESTIONS.length).fill(null), contact: {} };
  var advancing = false;

  var el = function (id) { return document.getElementById(id); };
  var screens = { intro: el("screen-intro"), q: el("screen-q"), contact: el("screen-contact"), result: el("screen-result") };

  function show(name) {
    Object.keys(screens).forEach(function (k) { screens[k].hidden = k !== name; });
    var active = screens[name];
    active.classList.remove("anim-in");
    void active.offsetWidth;
    active.classList.add("anim-in");
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function updateProgress() {
    var total = QUESTIONS.length + 1; // 8 perguntas + contato
    var done = state.step < 0 ? 0 : Math.min(state.step + 1, total);
    var pct = Math.round(done / total * 100);
    el("progressWrap").hidden = state.step < 0;
    el("progressBar").style.width = pct + "%";
    el("progressWrap").setAttribute("aria-valuenow", String(pct));
  }

  function renderQuestion() {
    advancing = false;
    var i = state.step;
    var Q = QUESTIONS[i];
    el("qCount").textContent = "Pergunta " + (i + 1) + " de " + QUESTIONS.length;
    el("qTitle").textContent = Q.q;
    var hint = el("qHint");
    if (Q.hint) { hint.textContent = Q.hint; hint.hidden = false; } else { hint.hidden = true; }

    var box = el("qOptions");
    box.innerHTML = "";
    var letters = "ABCDE";
    Q.opts.forEach(function (o, idx) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.setAttribute("role", "radio");
      var checked = state.answers[i] === idx;
      b.setAttribute("aria-checked", checked ? "true" : "false");
      // roving tabindex: so um item do grupo e tab-stop
      b.tabIndex = checked || (state.answers[i] == null && idx === 0) ? 0 : -1;
      b.innerHTML = '<span class="mk">' + letters[idx] + '</span><span>' + o.t + '</span>';
      b.addEventListener("click", function () { choose(idx); });
      box.appendChild(b);
    });
    el("backBtn").textContent = "";
    el("backBtn").insertAdjacentHTML("afterbegin",
      '<svg viewBox="0 0 24 24" fill="none"><path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      (i === 0 ? "Início" : "Voltar"));
    show("q");
    updateProgress();
    // foco no enunciado para leitor de tela anunciar a nova pergunta
    el("qTitle").focus();
  }

  function choose(idx) {
    if (advancing) return;
    var i = state.step;
    state.answers[i] = idx;
    var box = el("qOptions");
    Array.prototype.forEach.call(box.children, function (c, k) {
      c.setAttribute("aria-checked", k === idx ? "true" : "false");
      c.tabIndex = k === idx ? 0 : -1;
    });
    advancing = true;
    setTimeout(next, 240);
  }

  // Setas navegam o radiogroup (padrao ARIA), 1-5 seleciona
  el("qOptions").addEventListener("keydown", function (e) {
    var box = el("qOptions");
    var opts = Array.prototype.slice.call(box.children);
    var cur = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      var n = opts[(cur + 1 + opts.length) % opts.length]; if (n) n.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      var p = opts[(cur - 1 + opts.length) % opts.length]; if (p) p.focus();
    }
  });

  function next() {
    if (state.step < QUESTIONS.length - 1) {
      state.step++;
      renderQuestion();
    } else {
      state.step = QUESTIONS.length;
      show("contact");
      updateProgress();
      setTimeout(function () { el("f-nome").focus(); }, 260);
    }
  }

  function back() {
    if (state.step <= 0) { state.step = -1; show("intro"); updateProgress(); return; }
    state.step--;
    renderQuestion();
  }

  el("startBtn").addEventListener("click", function () { state.step = 0; renderQuestion(); });
  el("backBtn").addEventListener("click", back);
  el("backBtnContact").addEventListener("click", function () { state.step = QUESTIONS.length - 1; renderQuestion(); });

  function digits(s) { return (s || "").replace(/[^0-9]/g, ""); }

  el("f-wpp").addEventListener("input", function (e) {
    var d = digits(e.target.value).slice(0, 11);
    var out = d;
    if (d.length > 2 && d.length <= 6) out = "(" + d.slice(0, 2) + ") " + d.slice(2);
    else if (d.length > 6 && d.length <= 10) out = "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
    else if (d.length > 10) out = "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
    e.target.value = out;
  });

  function setErr(inputId, errId, msg) {
    el(errId).textContent = msg || "";
    var inp = el(inputId);
    if (inp) { if (msg) inp.setAttribute("aria-invalid", "true"); else inp.removeAttribute("aria-invalid"); }
  }

  el("contactForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var nome = el("f-nome").value.trim();
    var wpp = digits(el("f-wpp").value);
    var email = el("f-email").value.trim();
    var seg = el("f-seg").value;
    var ok = el("f-ok").checked;
    var valid = true;
    var firstBad = null;

    setErr("f-nome", "err-nome", ""); setErr("f-wpp", "err-wpp", ""); setErr("f-email", "err-email", ""); setErr("f-seg", "err-seg", ""); el("err-ok").textContent = "";

    var at = email.indexOf("@");
    var emailOk = at > 0 && email.lastIndexOf(".") > at + 1 && email.indexOf(" ") < 0;

    if (nome.length < 2) { setErr("f-nome", "err-nome", "Escreva seu nome."); valid = false; firstBad = firstBad || "f-nome"; }
    if (wpp.length < 10) { setErr("f-wpp", "err-wpp", "Coloque o WhatsApp com DDD."); valid = false; firstBad = firstBad || "f-wpp"; }
    if (!emailOk) { setErr("f-email", "err-email", "Coloque um e-mail válido."); valid = false; firstBad = firstBad || "f-email"; }
    if (!seg) { setErr("f-seg", "err-seg", "Escolha uma opção."); valid = false; firstBad = firstBad || "f-seg"; }
    if (!ok) { el("err-ok").textContent = "Marque para receber o diagnóstico."; valid = false; firstBad = firstBad || "f-ok"; }
    if (!valid) { if (firstBad) el(firstBad).focus(); return; }

    state.contact = { nome: nome, whatsapp: wpp, email: email, segmento: seg };

    var btn = el("submitBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Analisando...';

    // Envia o lead pro CRM (best-effort). O resultado aparece de qualquer jeito,
    // mesmo sem rede, entao funciona igual na previa e em producao.
    var score = computeScore();
    var respostas = QUESTIONS.map(function (Q, i) {
      var a = state.answers[i];
      return { pergunta: Q.q, resposta: a != null ? Q.opts[a].t : null };
    });
    var payload = {
      nome: nome, whatsapp: wpp, email: email, segmento: seg, site: el("f-site").value,
      indice: score.pct, faixa: tierFor(score.pct).risk, respostas: respostas
    };
    var done = false;
    function go() { if (done) return; done = true; showResult(); }
    try {
      fetch("/api/public/diagnostico", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).then(function () { setTimeout(go, 400); }, function () { setTimeout(go, 400); });
    } catch (e) { setTimeout(go, 400); }
    setTimeout(go, 2500); // failsafe
  });

  function computeScore() {
    var raw = 0;
    state.answers.forEach(function (a, i) { if (a != null && QUESTIONS[i].scored) raw += QUESTIONS[i].opts[a].w; });
    return { raw: raw, pct: Math.round(raw / MAX * 100) };
  }

  function w(i) { return state.answers[i] != null ? QUESTIONS[i].opts[state.answers[i]].w : 0; }

  function pickFixes() {
    var set = [];
    function add(k) { if (FIXES[k] && set.indexOf(k) < 0) set.push(k); }
    if (w(0) >= 3 || w(5) >= 2) add("inbox");
    if (w(1) >= 2) add("funil");
    if (w(2) >= 2 || w(4) >= 2) add("followup");
    if (w(3) >= 2 || w(6) >= 2) add("origem");
    if (w(7) >= 2) add("ia");
    ["funil", "followup", "inbox", "origem", "ia"].forEach(function (k) { if (set.length < 3) add(k); });
    return set.slice(0, 4);
  }

  function tierFor(pct) {
    if (pct <= 30) return {
      title: "Seu atendimento está sob controle.", greet: "Boa notícia, ",
      lead: "Você já organiza bem. O FluxiaCRM entra pra ganhar escala: mais velocidade, mais gente atendendo junto e visão de tudo sem esforço.",
      risk: "Vazamento baixo", color: "var(--ok)", bg: "rgba(87,217,168,0.12)", border: "rgba(87,217,168,0.35)"
    };
    if (pct <= 62) return {
      title: "Você está vazando venda sem perceber.", greet: "Olha, ",
      lead: "Tem cliente esfriando e informação espalhada. Dá pra tampar esses furos rápido e recuperar o que hoje escorre pelo caminho.",
      risk: "Vazamento médio", color: "var(--risk)", bg: "rgba(255,138,107,0.12)", border: "rgba(255,138,107,0.35)"
    };
    return {
      title: "Do jeito que está, muita venda escapa sem você ver.", greet: "Atenção, ",
      lead: "Bastante lead entra e some pelo caminho. A boa notícia: é exatamente isso que o FluxiaCRM foi feito pra resolver.",
      risk: "Vazamento alto", color: "var(--risk)", bg: "rgba(255,138,107,0.16)", border: "rgba(255,138,107,0.45)"
    };
  }

  function showResult() {
    var s = computeScore();
    var tier = tierFor(s.pct);
    var firstName = (state.contact.nome || "").split(" ")[0];

    el("resGreet").textContent = firstName ? (tier.greet + firstName) : "Seu resultado";
    el("resTitle").textContent = tier.title;
    el("resLead").textContent = tier.lead;
    el("resConfirm").textContent = firstName
      ? ("Recebemos seus dados, " + firstName + ". Um especialista da Fluxia vai te chamar no seu WhatsApp.")
      : "Recebemos seus dados. Um especialista da Fluxia vai te chamar no seu WhatsApp.";

    var pill = el("riskPill");
    pill.textContent = tier.risk;
    pill.style.color = tier.color;
    pill.style.background = tier.bg;
    pill.style.border = "1px solid " + tier.border;

    var list = el("fixList");
    list.innerHTML = "";
    pickFixes().forEach(function (key) {
      var f = FIXES[key];
      var row = document.createElement("div");
      row.className = "fix";
      row.innerHTML = '<span class="ic"><svg viewBox="0 0 24 24" fill="none">' + ICONS[f.ic] + '</svg></span>' +
        '<div><div class="ft">' + f.t + '</div><div class="fd">' + f.d + '</div></div>';
      list.appendChild(row);
    });

    el("ctaTrial").href = "https://crm.salestecnologia.com.br/comecar";
    var msg = encodeURIComponent("Oi! Fiz o diagnóstico da FluxiaCRM e quero organizar meu atendimento.");
    el("ctaWpp").href = "https://wa.me/5567936184092?text=" + msg;

    show("result");
    el("progressWrap").hidden = true;

    var ring = el("gaugeVal"), num = el("gaugeNum");
    requestAnimationFrame(function () { ring.style.strokeDashoffset = String(100 - s.pct); });
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { num.textContent = s.pct; return; }
    var start = null, dur = 1300;
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      num.textContent = Math.round(p * s.pct);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // 1-5 seleciona a opcao correspondente
  document.addEventListener("keydown", function (e) {
    if (screens.q.hidden) return;
    var n = parseInt(e.key, 10);
    if (n >= 1 && n <= 5) {
      var opts = el("qOptions").children;
      if (opts[n - 1]) opts[n - 1].click();
    }
  });
})();
</script>

</html>`;
