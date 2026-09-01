"use client";

// ============================================================
// AdminSupport — o setor Suporte do /admin.
//
// - Cards (Abertos / Em andamento / Resolvidos / Total) que filtram a lista.
// - Cada chamado: tipo, cliente, autor, assunto, prints (abrem em nova aba),
//   status editável (PATCH /api/admin/support/[id]).
// - "Copiar p/ IA": monta um brief do bug pra colar pro Claude/Hermes
//   resolver (ver a skill fluxia-suporte-bug).
//
// Busca GET /api/admin/support; refetch após cada mutação.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  RefreshCw,
  HelpCircle,
  Settings2,
  Bug,
  Copy,
  ExternalLink,
  MessageCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  TICKET_TYPE_LABEL,
  TICKET_STATUS_LABEL,
  type AdminSupportTicketDTO,
  type SupportOverview,
  type SupportTicketStatus,
  type SupportTicketType,
} from "@/lib/support/types";

const TYPE_ICON: Record<SupportTicketType, typeof HelpCircle> = {
  question: HelpCircle,
  config: Settings2,
  problem: Bug,
};

const EMPTY: SupportOverview = { open: 0, inProgress: 0, resolved: 0, total: 0 };

type Filter = "all" | SupportTicketStatus;

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

/** Brief compacto do chamado pra colar pro Claude/Hermes resolver. */
function briefFor(t: AdminSupportTicketDTO): string {
  const lines = [
    `[Suporte Fluxia] Resolver este chamado:`,
    ``,
    `Tipo: ${TICKET_TYPE_LABEL[t.type]}`,
    `Cliente: ${t.org?.name ?? "—"}`,
    `Aberto por: ${[t.createdByUser?.name, t.createdByUser?.email].filter(Boolean).join(" · ") || "—"}`,
    `Assunto: ${t.subject}`,
    `Descrição: ${t.description ?? "—"}`,
    `Tela: ${t.context.url ?? "—"}`,
    `Navegador: ${t.context.userAgent ?? "—"}`,
    `Prints: ${t.screenshotUrls.length ? t.screenshotUrls.join(" , ") : "nenhum"}`,
    `ticket_id: ${t.id}`,
  ];
  return lines.join("\n");
}

function OverviewCard({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: number;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      <Card
        size="sm"
        className={cn(
          "transition-colors hover:border-primary/50",
          active && "border-primary ring-1 ring-primary/40",
        )}
      >
        <CardContent>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
        </CardContent>
      </Card>
    </button>
  );
}

function StatusBadge({ status }: { status: SupportTicketStatus }) {
  if (status === "resolved") {
    return (
      <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
        {TICKET_STATUS_LABEL[status]}
      </Badge>
    );
  }
  if (status === "in_progress") {
    return (
      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-400">
        {TICKET_STATUS_LABEL[status]}
      </Badge>
    );
  }
  return (
    <Badge className="border-sky-500/40 bg-sky-500/10 text-sky-400">
      {TICKET_STATUS_LABEL[status]}
    </Badge>
  );
}

export function AdminSupport() {
  const [tickets, setTickets] = useState<AdminSupportTicketDTO[]>([]);
  const [overview, setOverview] = useState<SupportOverview>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/support", { cache: "no-store" });
      if (!res.ok) {
        toast.error("Não foi possível carregar os chamados.");
        return;
      }
      const data = (await res.json()) as {
        tickets: AdminSupportTicketDTO[];
        overview: SupportOverview;
      };
      setTickets(data.tickets ?? []);
      setOverview(data.overview ?? EMPTY);
    } catch (err) {
      console.error("[AdminSupport] load error:", err);
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // "Resolver" abre um campo pra contar ao cliente o que foi feito — esse
  // texto vai no WhatsApp dele junto com o aviso de resolvido.
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [zap, setZap] = useState("");

  function resolveWithNote(t: AdminSupportTicketDTO) {
    setResolvingId(t.id);
    setNote("");
    setZap(t.whatsapp ?? "");
  }

  async function setStatus(
    t: AdminSupportTicketDTO,
    status: SupportTicketStatus,
    resolutionNote?: string | null,
    whatsapp?: string | null,
  ) {
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/admin/support/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          resolution_note: resolutionNote ?? null,
          whatsapp: whatsapp?.trim() || null,
        }),
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        toast.error(p.error || "Não foi possível atualizar o status.");
        return;
      }
      // A rota devolve se o cliente foi avisado no WhatsApp dele.
      const payload = (await res.json().catch(() => ({}))) as {
        clientNotified?: { sent: boolean; error?: string } | null;
      };
      if (payload.clientNotified?.sent) {
        toast.success("Resolvido — cliente avisado no WhatsApp. 🙌");
      } else if (payload.clientNotified && !payload.clientNotified.sent) {
        toast.warning(
          `Resolvido, mas não deu pra avisar o cliente: ${payload.clientNotified.error ?? "falha no envio"}`,
        );
      }
      await load();
    } catch (err) {
      console.error("[AdminSupport] status error:", err);
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setBusyId(null);
    }
  }

  async function copyBrief(t: AdminSupportTicketDTO) {
    try {
      await navigator.clipboard.writeText(briefFor(t));
      toast.success("Brief copiado — cole pro Claude/Hermes resolver.");
    } catch {
      toast.error("Falha ao copiar.");
    }
  }

  function pick(next: Filter) {
    setFilter((prev) => (prev === next ? "all" : next));
  }

  const visible = tickets.filter((t) =>
    filter === "all" ? true : t.status === filter,
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground">
            Suporte
          </h1>
          <p className="text-sm text-muted-foreground">
            Chamados abertos pelos clientes — com print e contexto do problema.
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()}>
          <RefreshCw className="size-4" />
          Atualizar
        </Button>
      </div>

      {/* Overview */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <OverviewCard
          label="Total"
          value={overview.total}
          active={filter === "all"}
          onClick={() => setFilter("all")}
        />
        <OverviewCard
          label="Abertos"
          value={overview.open}
          active={filter === "open"}
          onClick={() => pick("open")}
        />
        <OverviewCard
          label="Em andamento"
          value={overview.inProgress}
          active={filter === "in_progress"}
          onClick={() => pick("in_progress")}
        />
        <OverviewCard
          label="Resolvidos"
          value={overview.resolved}
          active={filter === "resolved"}
          onClick={() => pick("resolved")}
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Carregando chamados…
        </div>
      ) : visible.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          {tickets.length === 0
            ? "Nenhum chamado ainda."
            : "Nenhum chamado com esse filtro."}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((t) => {
            const Icon = TYPE_ICON[t.type];
            const rowBusy = busyId === t.id;
            return (
              <Card key={t.id}>
                <CardContent className="space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 text-muted-foreground">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">
                          {t.subject}
                        </span>
                        <StatusBadge status={t.status} />
                        <Badge variant="outline" className="text-muted-foreground">
                          {TICKET_TYPE_LABEL[t.type]}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {t.org?.name ?? "—"}
                        </span>
                        {" · "}
                        {[t.createdByUser?.name, t.createdByUser?.email]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                        {" · "}
                        {fmt(t.createdAt)}
                        {t.whatsapp ? (
                          <>
                            {" · "}
                            <a
                              href={`https://wa.me/${t.whatsapp}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                            >
                              {t.whatsapp}
                            </a>
                          </>
                        ) : null}
                        {t.alertedAt ? (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-emerald-400">
                            <MessageCircle className="size-3" /> zap enviado
                          </span>
                        ) : null}
                        {t.clientNotifiedAt ? (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-emerald-400">
                            <MessageCircle className="size-3" /> cliente avisado
                          </span>
                        ) : null}
                      </p>
                      {t.description ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/90">
                          {t.description}
                        </p>
                      ) : null}
                      {t.context.url ? (
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          Tela: {t.context.url}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* Prints */}
                  {t.screenshotUrls.length > 0 ? (
                    <div className="flex flex-wrap gap-2 pl-7">
                      {t.screenshotUrls.map((url, i) => (
                        <a
                          key={i}
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="group relative block size-24 overflow-hidden rounded-lg border border-border"
                          title="Abrir print"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt=""
                            className="size-full object-cover"
                          />
                          <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
                            <ExternalLink className="size-4" />
                          </span>
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {/* Resolver: conta ao cliente o que foi feito (vai no zap dele). */}
                  {resolvingId === t.id ? (
                    <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground">
                        {t.whatsapp
                          ? `O cliente vai receber esta mensagem no WhatsApp ${t.whatsapp}:`
                          : "Este chamado foi aberto sem WhatsApp. Informe o número para avisar o cliente (ou deixe vazio para só resolver)."}
                      </p>
                      {!t.whatsapp ? (
                        <input
                          value={zap}
                          onChange={(e) => setZap(e.target.value)}
                          placeholder="WhatsApp do cliente — (67) 99999-9999"
                          inputMode="tel"
                          maxLength={20}
                          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
                        />
                      ) : null}
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                        maxLength={600}
                        placeholder="O que foi feito (opcional). Ex.: Ajustamos e já está funcionando — atualize a página com Cmd+Shift+R."
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
                      />
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setResolvingId(null)}
                        >
                          Cancelar
                        </Button>
                        <Button
                          size="sm"
                          disabled={rowBusy}
                          onClick={() => {
                            setResolvingId(null);
                            void setStatus(t, "resolved", note, zap);
                          }}
                        >
                          {rowBusy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : null}
                          {t.whatsapp || zap.trim()
                            ? "Resolver e avisar cliente"
                            : "Resolver"}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {/* Ações */}
                  <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copyBrief(t)}
                      title="Copiar o brief do bug pra IA resolver"
                    >
                      <Copy className="size-3.5" /> Copiar p/ IA
                    </Button>
                    {t.status !== "in_progress" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rowBusy}
                        onClick={() => void setStatus(t, "in_progress")}
                      >
                        {rowBusy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        Em andamento
                      </Button>
                    ) : null}
                    {t.status !== "resolved" ? (
                      <Button
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => void resolveWithNote(t)}
                      >
                        {rowBusy ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : null}
                        Resolver
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rowBusy}
                        onClick={() => void setStatus(t, "open")}
                      >
                        Reabrir
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
