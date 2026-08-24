"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 💬 Landing que Conversa — o chat embutido na landing (no lugar do
 * formulário). Stateless: manda o histórico a cada turno pro endpoint
 * público; quando a IA captura o lead, mostra o selo verde + botão de
 * continuar no WhatsApp. Visual "produto de IA": header em degradê da cor da
 * marca com avatar, sugestões de pergunta no primeiro turno, balões
 * refinados. Tema claro, cor da marca.
 */
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** Escurece um hex (pro degradê do header ancorado na cor da marca). */
function darken(hex: string, amt = 0.24): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (c: number) => Math.max(0, Math.round(c * (1 - amt)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

const DEFAULT_SUGGESTIONS = [
  "Como funciona?",
  "Quanto custa?",
  "Quero ver na prática",
];

export function CaptureChatClient({
  slug,
  greeting,
  accent,
  logo,
  suggestions,
}: {
  slug: string;
  greeting: string;
  accent: string;
  /** Logo da marca — vira o avatar do header. */
  logo?: string | null;
  /** Perguntas prontas mostradas no primeiro turno (chips clicáveis). */
  suggestions?: string[];
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: "assistant", content: greeting },
  ]);
  const [input, setInput] = useState("");
  const [site, setSite] = useState(""); // honeypot
  const [sending, setSending] = useState(false);
  const [leadDone, setLeadDone] = useState(false);
  const [waHref, setWaHref] = useState<string | null>(null);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const userTurns = messages.filter((m) => m.role === "user").length;
  const capped = userTurns >= 20;
  const chips = suggestions?.length ? suggestions : DEFAULT_SUGGESTIONS;
  const showChips = messages.length === 1 && !sending && !capped;

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  async function sendText(raw: string) {
    const text = raw.trim();
    if (!text || sending || capped) return;
    setError("");
    setInput("");
    // O histórico enviado NÃO inclui a saudação inicial (a IA já se apresenta
    // pelo prompt) nem a mensagem nova (vai no campo próprio).
    const history = messages.slice(1);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setSending(true);
    try {
      const r = await fetch("/api/public/capture/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, site, history, message: text, leadDone }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        reply?: string;
        leadCaptured?: boolean;
        waHref?: string | null;
        error?: string;
      };
      if (!r.ok || !j.ok || !j.reply) {
        setError(j.error || "Não consegui responder agora. Tente de novo.");
        setSending(false);
        return;
      }
      setMessages((prev) => [...prev, { role: "assistant", content: j.reply! }]);
      if (j.leadCaptured) {
        setLeadDone(true);
        setWaHref(j.waHref ?? null);
      }
    } catch {
      setError("Erro de conexão. Tente de novo.");
    } finally {
      setSending(false);
    }
  }

  function send(e: React.FormEvent) {
    e.preventDefault();
    void sendText(input);
  }

  return (
    <div className="w-full overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-slate-900/10">
      <div
        className="flex items-center gap-2.5 px-4 py-3"
        style={{
          background: `linear-gradient(135deg, ${accent} 0%, ${darken(accent)} 100%)`,
        }}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/95 text-base shadow-sm">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="h-full w-full object-cover" />
          ) : (
            "🤖"
          )}
        </span>
        <span className="text-sm font-semibold text-white">
          Converse com a gente
        </span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-300" />
          </span>
          online agora
        </span>
      </div>

      <div ref={scrollRef} className="h-80 space-y-2.5 overflow-y-auto bg-slate-50/60 p-4">
        {messages.map((m, i) => (
          <div
            key={i}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                m.role === "user" ? "" : "border border-slate-200 bg-white shadow-sm"
              }`}
              style={
                m.role === "user"
                  ? {
                      background: `linear-gradient(135deg, ${accent} 0%, ${darken(accent, 0.16)} 100%)`,
                      color: "#ffffff",
                      borderBottomRightRadius: 6,
                    }
                  : {
                      color: "#1e293b",
                      borderBottomLeftRadius: 6,
                    }
              }
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending ? (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm">
              <span className="inline-flex gap-1">
                {[0, 1, 2].map((d) => (
                  <span
                    key={d}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
                    style={{ animationDelay: `${d * 150}ms` }}
                  />
                ))}
              </span>
            </div>
          </div>
        ) : null}
        {showChips ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => void sendText(c)}
                className="rounded-full border bg-white px-3 py-1.5 text-xs font-medium transition hover:shadow-sm"
                style={{ borderColor: `${accent}55`, color: accent }}
              >
                {c}
              </button>
            ))}
          </div>
        ) : null}
        {leadDone ? (
          <div className="space-y-2 pt-1">
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 px-3.5 py-2 text-center text-xs font-semibold text-emerald-700">
              ✅ Contato recebido — nossa equipe vai te chamar!
            </div>
            {waHref ? (
              <a
                href={waHref}
                target="_blank"
                rel="noreferrer"
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-600"
              >
                💬 Continuar no WhatsApp
              </a>
            ) : null}
          </div>
        ) : null}
      </div>

      <form
        onSubmit={send}
        className="flex items-center gap-2 border-t border-slate-200 bg-white p-3"
      >
        {/* Honeypot: invisível pra humanos, tentador pra bots. */}
        <input
          type="text"
          name="site"
          tabIndex={-1}
          autoComplete="off"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          className="absolute -left-[9999px] h-0 w-0 opacity-0"
          aria-hidden="true"
        />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={600}
          disabled={capped}
          placeholder={
            capped
              ? "Deixe seu WhatsApp que a equipe continua com você 😊"
              : "Escreva sua mensagem..."
          }
          className="h-10 flex-1 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500 disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={sending || capped || !input.trim()}
          className="h-10 rounded-xl px-4 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          style={{ background: accent }}
        >
          Enviar
        </button>
      </form>
      {error ? (
        <p className="bg-white px-4 pb-3 text-xs text-rose-600">{error}</p>
      ) : null}
    </div>
  );
}
