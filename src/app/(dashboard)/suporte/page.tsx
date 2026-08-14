"use client";

// ============================================================
// /suporte — o cliente abre um chamado (dúvida / configuração / problema).
//
// Cola o print do erro (Cmd/Ctrl+V), arrasta ou anexa arquivo; descreve o
// problema. Ao enviar, o chamado é registrado E dispara um alerta no
// WhatsApp da Fluxia com o print + contexto (tela, navegador, org, usuário).
// Embaixo, o histórico dos chamados da conta com o status.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  LifeBuoy,
  Loader2,
  ImagePlus,
  Send,
  X,
  HelpCircle,
  Settings2,
  Bug,
  CheckCircle2,
  Clock3,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import {
  SUPPORT_TICKET_TYPES,
  TICKET_TYPE_LABEL,
  TICKET_TYPE_HINT,
  TICKET_STATUS_LABEL,
  type SupportTicketDTO,
  type SupportTicketType,
} from "@/lib/support/types";

const TYPE_ICON: Record<SupportTicketType, typeof HelpCircle> = {
  question: HelpCircle,
  config: Settings2,
  problem: Bug,
};

interface Shot {
  id: string;
  url: string;
  name: string;
}

/** DD/MM HH:mm curtinho pro histórico. */
function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

function StatusBadge({ status }: { status: SupportTicketDTO["status"] }) {
  if (status === "resolved") {
    return (
      <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
        <CheckCircle2 className="size-3" /> {TICKET_STATUS_LABEL[status]}
      </Badge>
    );
  }
  if (status === "in_progress") {
    return (
      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-400">
        <Clock3 className="size-3" /> {TICKET_STATUS_LABEL[status]}
      </Badge>
    );
  }
  return (
    <Badge className="border-sky-500/40 bg-sky-500/10 text-sky-400">
      {TICKET_STATUS_LABEL[status]}
    </Badge>
  );
}

export default function SuportePage() {
  const [type, setType] = useState<SupportTicketType>("problem");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [tickets, setTickets] = useState<SupportTicketDTO[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/support/tickets", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { tickets: SupportTicketDTO[] };
        setTickets(data.tickets ?? []);
      }
    } catch (err) {
      console.error("[suporte] load error:", err);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    for (const file of images) {
      setUploading((n) => n + 1);
      try {
        const { publicUrl } = await uploadAccountMedia("media", file);
        setShots((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.round(prev.length + 1)}`,
            url: publicUrl,
            name: file.name || "print.png",
          },
        ]);
      } catch (err) {
        console.error("[suporte] upload error:", err);
        toast.error("Não foi possível anexar o print. Tente de novo.");
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
  }, []);

  // Colar (Cmd/Ctrl+V) em qualquer lugar da tela cola o print da área de
  // transferência — o jeito que o cliente já tirou o print do erro.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  function removeShot(id: string) {
    setShots((prev) => prev.filter((s) => s.id !== id));
  }

  async function submit() {
    const s = subject.trim();
    if (!s) {
      toast.error("Escreva um assunto pro chamado.");
      return;
    }
    setSubmitting(true);
    try {
      const context = {
        url: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        language:
          typeof navigator !== "undefined" ? navigator.language : undefined,
        viewport:
          typeof window !== "undefined"
            ? `${window.innerWidth}x${window.innerHeight}`
            : undefined,
        referrer:
          typeof document !== "undefined" ? document.referrer : undefined,
      };
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          subject: s,
          description: description.trim() || null,
          screenshot_urls: shots.map((x) => x.url),
          context,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ticket?: SupportTicketDTO;
        alerted?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(payload.error || "Não foi possível abrir o chamado.");
        return;
      }
      toast.success(
        payload.alerted
          ? "Chamado enviado! Nossa equipe já recebeu no WhatsApp. 🙌"
          : "Chamado registrado! Nossa equipe vai olhar.",
      );
      // Reset + prepend to history.
      setSubject("");
      setDescription("");
      setShots([]);
      if (payload.ticket) setTickets((prev) => [payload.ticket!, ...prev]);
      else void load();
    } catch (err) {
      console.error("[suporte] submit error:", err);
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || uploading > 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <LifeBuoy className="size-5" />
        </div>
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground">
            Suporte
          </h1>
          <p className="text-sm text-muted-foreground">
            Dúvida, ajuda com configuração ou algum problema? Abra um chamado —
            cole o print do erro e a gente já recebe no WhatsApp.
          </p>
        </div>
      </div>

      {/* Form */}
      <Card>
        <CardContent className="space-y-5">
          {/* Tipo */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">Tipo do chamado</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {SUPPORT_TICKET_TYPES.map((t) => {
                const Icon = TYPE_ICON[t];
                const active = type === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                      active
                        ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                        : "border-border hover:border-primary/50",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <Icon className="size-4" />
                      {TICKET_TYPE_LABEL[t]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {TICKET_TYPE_HINT[t]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Assunto */}
          <div className="space-y-2">
            <Label htmlFor="subject" className="text-muted-foreground">
              Assunto
            </Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Resumo curto (ex.: não consigo conectar o WhatsApp)"
              maxLength={200}
            />
          </div>

          {/* Descrição */}
          <div className="space-y-2">
            <Label htmlFor="desc" className="text-muted-foreground">
              O que está acontecendo?
            </Label>
            <Textarea
              id="desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descreva o que você esperava e o que aconteceu. Se aparecer uma mensagem de erro, cole aqui ou mande o print."
              rows={4}
            />
          </div>

          {/* Prints — área grande: arrastar, colar ou clicar. */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">Prints do erro</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={(e) => {
                // Só desliga quando sai de fato do container (não dos filhos).
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                setDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                void addFiles(Array.from(e.dataTransfer.files));
              }}
              className={cn(
                "flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition-colors",
                dragActive
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/50 hover:bg-muted/40",
              )}
            >
              {shots.length > 0 || uploading > 0 ? (
                <div
                  className="flex flex-wrap justify-center gap-2"
                  // Clicar num print (ou no X) não deve reabrir o seletor.
                  onClick={(e) => e.stopPropagation()}
                >
                  {shots.map((s) => (
                    <div
                      key={s.id}
                      className="group relative size-24 overflow-hidden rounded-lg border border-border"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={s.url}
                        alt={s.name}
                        className="size-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeShot(s.id)}
                        className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                        title="Remover"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  {uploading > 0 ? (
                    <div className="flex size-24 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                    </div>
                  ) : null}
                  <div className="flex size-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-muted-foreground">
                    <ImagePlus className="size-5" />
                    <span className="text-[10px]">Adicionar</span>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <ImagePlus className="size-5" />
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {dragActive
                      ? "Solte o print aqui"
                      : "Arraste o print aqui ou clique para escolher"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Também dá pra colar com{" "}
                    <kbd className="rounded bg-muted px-1">⌘/Ctrl</kbd>+
                    <kbd className="rounded bg-muted px-1">V</kbd>
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button onClick={() => void submit()} disabled={busy}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Enviando…
                </>
              ) : (
                <>
                  <Send className="size-4" />
                  Enviar chamado
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Histórico */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          Seus chamados
        </h2>
        {loadingList ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Carregando…
          </div>
        ) : tickets.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Você ainda não abriu nenhum chamado.
          </p>
        ) : (
          <div className="space-y-2">
            {tickets.map((t) => {
              const Icon = TYPE_ICON[t.type];
              return (
                <Card key={t.id} size="sm">
                  <CardContent className="flex items-start gap-3">
                    <div className="mt-0.5 text-muted-foreground">
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">
                          {t.subject}
                        </span>
                        <StatusBadge status={t.status} />
                      </div>
                      {t.description ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {t.description}
                        </p>
                      ) : null}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {TICKET_TYPE_LABEL[t.type]} · {fmt(t.createdAt)}
                        {t.screenshotUrls.length > 0
                          ? ` · ${t.screenshotUrls.length} print(s)`
                          : ""}
                      </p>
                    </div>
                    {t.screenshotUrls[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={t.screenshotUrls[0]}
                        alt=""
                        className="size-12 shrink-0 rounded-md border border-border object-cover"
                      />
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
