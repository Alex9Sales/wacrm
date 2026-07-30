"use client";

// ============================================================
// NewConversationDialog — start a thread with a number typed by hand.
//
// Mirrors WhatsApp Web's "nova conversa": the agent enters a phone number
// (and, optionally, a name) for someone who has never messaged in, we
// find-or-create the contact + conversation and deep-link the inbox to it so
// the agent can send right away. When the account has more than one connected
// channel, a picker chooses which number sends.
// ============================================================

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquarePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  listSendableChannels,
  startNewConversation,
  type SendableChannel,
} from "@/app/(dashboard)/inbox/actions";
import { isStaleActionError, reloadForStaleAction } from "@/lib/stale-action";

const PROVIDER_LABEL: Record<string, string> = {
  meta: "WhatsApp (Meta)",
  waha: "WhatsApp",
  evolution: "WhatsApp",
  evogo: "WhatsApp",
};

/**
 * Best-effort normalize to +E.164. Brazilian numbers typed without a country
 * code (10–11 digits: DDD + number) get +55; a leading `+` or a 55-prefixed
 * string is respected. Truly invalid input is rejected server-side, so we only
 * do the friendly BR default here.
 */
function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  if (hasPlus) return "+" + digits;
  if (digits.startsWith("55") && digits.length >= 12) return "+" + digits;
  if (digits.length === 10 || digits.length === 11) return "+55" + digits;
  return "+" + digits;
}

export function NewConversationDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the resolved conversation id so the parent can open it. */
  onStarted: (conversationId: string) => void;
}) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<SendableChannel[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPhone("");
    setName("");
    setChannelId("");
    setLoadingChannels(true);
    listSendableChannels()
      .then((list) => {
        setChannels(list);
        if (list.length === 1) setChannelId(list[0].id);
      })
      .catch(() => setChannels([]))
      .finally(() => setLoadingChannels(false));
  }, [open]);

  // Com mais de um canal, ESCOLHER o canal é obrigatório — senão a conversa
  // sairia por um canal qualquer (padrão). Felipe/cema: forçar a seleção.
  const needsChannel = channels.length > 1 && !channelId;
  const canSubmit = phone.trim().length > 0 && !submitting && !needsChannel;

  async function handleStart() {
    const normalized = toE164(phone);
    if (!normalized) {
      toast.error("Digite um número de telefone válido.");
      return;
    }
    setSubmitting(true);
    try {
      const { conversationId, contactCreated } = await startNewConversation({
        phone: normalized,
        name: name.trim() || null,
        channelId: channelId || null,
      });
      toast.success(
        contactCreated ? "Conversa iniciada." : "Conversa aberta.",
      );
      onStarted(conversationId);
      onOpenChange(false);
    } catch (err) {
      if (isStaleActionError(err)) {
        toast.info("Atualizando o sistema…");
        reloadForStaleAction();
        return;
      }
      toast.error(
        err instanceof Error ? err.message : "Não foi possível iniciar a conversa.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const noChannels = !loadingChannels && channels.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="size-4 text-primary" />
            Nova conversa
          </DialogTitle>
          <DialogDescription>
            Envie a primeira mensagem para um número que ainda não tem conversa.
            Digite o número com DDD (o país 55 é adicionado automaticamente no
            Brasil).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nc-phone">Número de telefone</Label>
            <Input
              id="nc-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) handleStart();
              }}
              placeholder="(67) 99220-9091 ou +55 67 99220-9091"
              inputMode="tel"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nc-name">Nome (opcional)</Label>
            <Input
              id="nc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Como salvar este contato"
              maxLength={80}
            />
          </div>

          {channels.length > 1 && (
            <div className="space-y-1.5">
              <Label>
                Enviar pelo número <span className="text-destructive">*</span>
              </Label>
              <Select value={channelId} onValueChange={(v) => v && setChannelId(v)}>
                <SelectTrigger
                  className={cn(
                    "w-full",
                    needsChannel && "border-destructive/60",
                  )}
                >
                  <SelectValue placeholder="Escolha o canal" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id}>
                      {ch.name || PROVIDER_LABEL[ch.provider] || "WhatsApp"}
                      {ch.phoneNumber ? ` · ${ch.phoneNumber}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {needsChannel && (
                <p className="text-xs text-muted-foreground">
                  Escolha por qual número a conversa vai sair.
                </p>
              )}
            </div>
          )}

          {noChannels && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Nenhum canal de WhatsApp conectado. Conecte um número em
              Configurações › Canais antes de iniciar uma conversa.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={handleStart} disabled={!canSubmit || noChannels}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            Iniciar conversa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
