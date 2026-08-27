"use client";

// ============================================================
// 🎯 Prospecção assistida (social selling — Peça 2).
// Cole os @s → a IA lê o perfil (bio, seguidores), qualifica contra o cliente
// ideal e escreve a 1ª abordagem personalizada. Você copia e envia manualmente
// (a API oficial não manda DM fria). Sem envio automático, sem scraping.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Radar,
  Copy,
  ExternalLink,
  Loader2,
  Sparkles,
  Info,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  analyzeProspects,
  listProspectChannels,
  type ProspectResult,
  type ProspectChannel,
  type Verdict,
} from "./actions";

const PREFILL_ICP =
  "Donos, sócios ou gestores de pequenas e médias empresas, autônomos, clínicas, " +
  "comércios e prestadores de serviço que atendem clientes por WhatsApp/Instagram e " +
  "perdem venda por demora na resposta, follow-up esquecido ou atendimento " +
  "desorganizado. NÃO é cliente ideal: perfil pessoal sem negócio; concorrente " +
  "(outra agência de marketing/automação ou outro CRM); quem só procura emprego.";

const inputCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50";

const VERDICT_META: Record<Verdict, { label: string; cls: string }> = {
  quente: { label: "🔥 Quente", cls: "bg-red-500/15 text-red-600 dark:text-red-400" },
  morno: { label: "🌤️ Morno", cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  frio: { label: "❄️ Frio", cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  fora: { label: "🚫 Fora do perfil", cls: "bg-muted text-muted-foreground" },
};

// Ordem de exibição: quente → morno → frio → fora.
const VERDICT_ORDER: Record<Verdict, number> = { quente: 0, morno: 1, frio: 2, fora: 3 };

export default function ProspeccaoPage() {
  const [channels, setChannels] = useState<ProspectChannel[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [criteria, setCriteria] = useState<string>(PREFILL_ICP);
  const [handlesText, setHandlesText] = useState<string>("");
  const [results, setResults] = useState<ProspectResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    listProspectChannels()
      .then((chs) => {
        setChannels(chs);
        if (chs.length) setChannelId((prev) => prev || chs[0].id);
      })
      .catch(() => setChannels([]));
  }, []);

  const handleCount = useMemo(
    () => handlesText.split(/[\n]+/).map((s) => s.trim()).filter(Boolean).length,
    [handlesText],
  );

  const sorted = useMemo(() => {
    if (!results) return null;
    return [...results].sort(
      (a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict],
    );
  }, [results]);

  const analyze = useCallback(async () => {
    const entries = handlesText.split(/[\n]+/).map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0) {
      toast.error("Cole pelo menos um @ pra analisar.");
      return;
    }
    if (!channelId) {
      toast.error("Conecte um Instagram na conta primeiro (Configurações → Canais).");
      return;
    }
    setLoading(true);
    try {
      const res = await analyzeProspects({ channelId, criteria, entries });
      setResults(res);
      if (res.length < entries.length) {
        toast.info(`Analisei os primeiros ${res.length} (o resto na próxima leva).`);
      }
    } catch (e) {
      toast.error((e as Error).message || "Falha ao analisar os perfis.");
    } finally {
      setLoading(false);
    }
  }, [handlesText, channelId, criteria]);

  const copyMsg = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      toast.success("Mensagem copiada — cole no direct e envie.");
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
    } catch {
      toast.error("Não consegui copiar. Selecione e copie manualmente.");
    }
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-6">
        <div className="flex items-center gap-2">
          <Radar className="size-6 text-primary" />
          <h1 className="text-xl font-semibold text-foreground">Prospecção assistida</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Cole os @s dos perfis que quer prospectar. A IA lê cada perfil, diz se
          é o seu cliente ideal e já escreve uma abordagem personalizada pra
          você <strong>copiar e enviar no direct</strong>.
        </p>
      </header>

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <span>
          O Instagram não permite mandar DM fria por API — por isso o envio é
          manual (você copia e cola). A leitura automática da bio depende do tipo
          de conexão do perfil; pra garantir uma abordagem certeira,{" "}
          <strong>escreva ao lado do @ uma linha do que é o negócio</strong> — a
          IA personaliza a partir disso.
        </span>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        {channels.length > 1 && (
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground">
              Perfil que faz a leitura
            </label>
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className={inputCls}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium text-foreground">
            Seu cliente ideal
          </label>
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            rows={4}
            className={inputCls}
            placeholder="Descreva quem é (e quem NÃO é) o seu cliente ideal."
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-foreground">
            Perfis pra analisar (um por linha: @ + o que é o negócio){" "}
            <span className="text-muted-foreground">— até 10 por vez</span>
          </label>
          <textarea
            value={handlesText}
            onChange={(e) => setHandlesText(e.target.value)}
            rows={6}
            className={`${inputCls} font-mono`}
            placeholder={
              "@padaria.donana padaria de bairro, vende encomenda pelo zap\n@studio.bella.nails estúdio de unhas, agenda cheia no direct\ninstagram.com/clinica.sorriso clínica odontológica"
            }
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {handleCount > 0
              ? `${handleCount} perfil(is) na lista`
              : "Cole o @ (ou o link) e, do lado, uma linha do que é o negócio."}
          </p>
        </div>

        <Button onClick={analyze} disabled={loading} className="w-full sm:w-auto">
          {loading ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" /> Analisando…
            </>
          ) : (
            <>
              <Sparkles className="mr-2 size-4" /> Analisar e escrever abordagens
            </>
          )}
        </Button>
      </div>

      {sorted && (
        <div className="mt-6 space-y-3">
          <div className="text-sm text-muted-foreground">
            {sorted.length} perfil(is) analisado(s)
          </div>
          {sorted.map((r) => {
            const meta = VERDICT_META[r.verdict];
            const key = r.handle;
            return (
              <div key={key} className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <a
                      href={`https://instagram.com/${r.handle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-foreground hover:text-primary hover:underline"
                    >
                      @{r.handle}
                    </a>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
                    >
                      {meta.label}
                    </span>
                  </div>
                  <a
                    href={`https://instagram.com/${r.handle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
                  >
                    Abrir no Instagram <ExternalLink className="size-3" />
                  </a>
                </div>

                <div className="mt-1.5 text-xs text-muted-foreground">
                  {r.found ? (
                    <>
                      {r.name ? <span className="text-foreground">{r.name}</span> : null}
                      {typeof r.followers === "number" ? (
                        <span> · {r.followers.toLocaleString("pt-BR")} seguidores</span>
                      ) : null}
                      {r.bio ? <div className="mt-0.5 line-clamp-2">{r.bio}</div> : null}
                    </>
                  ) : (
                    <span className="italic">Perfil não lido (conta pessoal/privada ou inexistente).</span>
                  )}
                </div>

                {r.reason ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Por quê:</span> {r.reason}
                  </div>
                ) : null}

                {r.message ? (
                  <div className="mt-3">
                    <div className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
                      {r.message}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        variant={copiedKey === key ? "secondary" : "default"}
                        onClick={() => copyMsg(key, r.message ?? "")}
                      >
                        <Copy className="mr-1.5 size-3.5" />
                        {copiedKey === key ? "Copiado!" : "Copiar mensagem"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 text-xs italic text-muted-foreground">
                    Fora do perfil — sem abordagem sugerida.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
