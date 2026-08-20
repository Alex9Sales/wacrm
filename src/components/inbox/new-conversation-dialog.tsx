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

import { useEffect, useRef, useState } from "react";
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
import { listContacts } from "@/app/(dashboard)/contacts/actions";
import {
  listSendableChannels,
  startNewConversation,
  startNewEmailConversation,
  type SendableChannel,
} from "@/app/(dashboard)/inbox/actions";
import { isStaleActionError, reloadForStaleAction } from "@/lib/stale-action";

const PROVIDER_LABEL: Record<string, string> = {
  meta: "WhatsApp (Meta)",
  waha: "WhatsApp",
  evolution: "WhatsApp",
  evogo: "WhatsApp",
  email: "E-mail",
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
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [channels, setChannels] = useState<SendableChannel[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Busca de contato salvo (Felipe): digitar o NOME e puxar quem já está nos
  // contatos, sem precisar do número. `justSelected` evita re-buscar logo após
  // escolher um contato (o valor do input vira o telefone dele).
  const [matches, setMatches] = useState<
    { id: string; name: string; phone: string }[]
  >([]);
  const justSelectedRef = useRef(false);

  // Canal selecionado → decide se o destinatário é TELEFONE (WhatsApp) ou
  // E-MAIL. Com 1 canal só, ele já vem escolhido; com vários, segue o picker.
  const selectedChannel = channels.find((c) => c.id === channelId);
  const isEmail = selectedChannel?.provider === "email";

  useEffect(() => {
    if (!open) return;
    setPhone("");
    setEmail("");
    setName("");
    setChannelId("");
    setMatches([]);
    setLoadingChannels(true);
    listSendableChannels()
      .then((list) => {
        setChannels(list);
        if (list.length === 1) setChannelId(list[0].id);
      })
      .catch(() => setChannels([]))
      .finally(() => setLoadingChannels(false));
  }, [open]);

  // Debounced search of SAVED contacts as the agent types (name or number).
  // Só no modo telefone — no e-mail o agente digita o endereço direto.
  useEffect(() => {
    if (!open || isEmail) return;
    if (justSelectedRef.current) {
      justSelectedRef.current = false;
      return;
    }
    const term = phone.trim();
    if (term.length < 2) {
      setMatches([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const { contacts } = await listContacts({
          offset: 0,
          limit: 6,
          search: term,
          tagIds: [],
        });
        setMatches(
          contacts
            .filter((c) => !c.is_group)
            .map((c) => ({ id: c.id, name: c.name ?? "", phone: c.phone })),
        );
      } catch {
        setMatches([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [phone, open, isEmail]);

  const selectContact = (m: { name: string; phone: string }) => {
    justSelectedRef.current = true;
    setPhone(m.phone);
    if (m.name) setName(m.name);
    setMatches([]);
  };

  // Com mais de um canal, ESCOLHER o canal é obrigatório — senão a conversa
  // sairia por um canal qualquer (padrão). Felipe/cema: forçar a seleção.
  const needsChannel = channels.length > 1 && !channelId;
  const recipientFilled = (isEmail ? email : phone).trim().length > 0;
  const canSubmit = recipientFilled && !submitting && !needsChannel;

  async function handleStart() {
    // Valida ANTES de travar o botão (senão fica preso num input inválido).
    if (isEmail) {
      const addr = email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
        toast.error("Digite um e-mail válido.");
        return;
      }
    } else if (!toE164(phone)) {
      toast.error("Digite um número de telefone válido.");
      return;
    }
    setSubmitting(true);
    try {
      const { conversationId, contactCreated } = isEmail
        ? await startNewEmailConversation({
            email: email.trim().toLowerCase(),
            name: name.trim() || null,
            channelId,
          })
        : await startNewConversation({
            phone: toE164(phone)!,
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
            Escolha o canal, informe o destinatário (número ou e-mail) e comece
            a conversa — mesmo com quem nunca te escreveu.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {channels.length > 1 && (
            <div className="space-y-1.5">
              <Label>
                Enviar pelo canal <span className="text-destructive">*</span>
              </Label>
              <Select value={channelId} onValueChange={(v) => v && setChannelId(v)}>
                <SelectTrigger
                  className={cn(
                    "w-full",
                    needsChannel && "border-destructive/60",
                  )}
                >
                  <SelectValue placeholder="Escolha o canal">
                    {(v: string) => {
                      const ch = channels.find((c) => c.id === v)
                      if (!ch) return "Escolha o canal"
                      const label =
                        ch.name || PROVIDER_LABEL[ch.provider] || "Canal"
                      return `${label}${ch.phoneNumber ? ` · ${ch.phoneNumber}` : ""}`
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {channels.map((ch) => (
                    <SelectItem key={ch.id} value={ch.id}>
                      {ch.name || PROVIDER_LABEL[ch.provider] || "Canal"}
                      {ch.phoneNumber ? ` · ${ch.phoneNumber}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {needsChannel && (
                <p className="text-xs text-muted-foreground">
                  Escolha por qual canal a conversa vai sair.
                </p>
              )}
            </div>
          )}

          {isEmail ? (
            <div className="space-y-1.5">
              <Label htmlFor="nc-email">E-mail do destinatário</Label>
              <Input
                id="nc-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) handleStart();
                }}
                placeholder="cliente@empresa.com"
                autoFocus
                autoComplete="off"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="nc-phone">Número ou nome do contato</Label>
              <div className="relative">
                <Input
                  id="nc-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && matches.length === 0 && canSubmit)
                      handleStart();
                  }}
                  placeholder="Digite o número novo ou busque um contato salvo"
                  autoFocus
                  autoComplete="off"
                />
                {matches.length > 0 && (
                  <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg">
                    {matches.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => selectContact(m)}
                        className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                      >
                        <span className="text-sm font-medium text-foreground">
                          {m.name || m.phone}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {m.phone}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

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

          {noChannels && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Nenhum canal conectado. Conecte um canal (WhatsApp ou e-mail) em
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
