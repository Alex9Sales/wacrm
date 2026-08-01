"use client";

// ============================================================
// ParticipantActionSheet — clicar no avatar de um participante num thread de
// GRUPO abre este painel (tipo WhatsApp): foto + nome + número. Todas as ações
// levam ao 1:1 daquela pessoa (via `onOpen`), porque é lá que está TUDO: o
// chat, a lateral pra adicionar info + criar negócio, e o botão de ligar (que
// só funciona com a conversa+canal). O telefone vem do `author_key` (a CRM já
// guarda o número puro do remetente do grupo).
// ============================================================

import { MessageSquare, Video, UserPlus, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContactAvatar } from "./contact-avatar";
import { cn } from "@/lib/utils";

export interface GroupParticipant {
  /** Telefone puro (E.164 sem "+"), vindo do author_key da mensagem. */
  phone: string;
  name: string;
  avatarUrl?: string | null;
}

interface ParticipantActionSheetProps {
  participant: GroupParticipant | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  /** Abre o 1:1 da pessoa (cria a conversa+contato se preciso). */
  onOpen: (p: GroupParticipant) => void;
  /** Abre o formulário de contato pré-preenchido (adicionar aos contatos). */
  onAdicionar: (p: GroupParticipant) => void;
}

/** "+55 67 99187-5477" a partir de "556791875477" (best-effort BR). */
function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    const mid =
      rest.length === 9
        ? `${rest.slice(0, 5)}-${rest.slice(5)}`
        : `${rest.slice(0, 4)}-${rest.slice(4)}`;
    return `+55 ${ddd} ${mid}`;
  }
  return `+${d}`;
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  hint,
  primary,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  hint?: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      className={cn(
        "flex flex-1 flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-xs font-medium transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-muted/40 text-muted-foreground/50"
          : primary
            ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
            : "border-border bg-muted text-foreground hover:bg-muted/70",
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-background/60">
        {icon}
      </span>
      {label}
    </button>
  );
}

export function ParticipantActionSheet({
  participant,
  open,
  onOpenChange,
  busy,
  onOpen,
  onAdicionar,
}: ParticipantActionSheetProps) {
  const p = participant;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="sr-only">Participante</DialogTitle>
        </DialogHeader>

        {p && (
          <div className="flex flex-col items-center gap-3 py-1">
            <ContactAvatar
              avatarUrl={p.avatarUrl}
              displayName={p.name}
              className="size-20 text-2xl"
            />
            <div className="text-center">
              <p className="text-base font-semibold text-foreground">
                {p.name || "Participante"}
              </p>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(`+${p.phone}`);
                  toast.success("Número copiado");
                }}
                className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                title="Copiar número"
              >
                {formatPhone(p.phone)}
                <Copy className="size-3" />
              </button>
            </div>

            {busy ? (
              <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Abrindo conversa…
              </div>
            ) : (
              <>
                <div className="mt-1 grid w-full grid-cols-3 gap-2">
                  <ActionButton
                    primary
                    icon={<MessageSquare className="size-4" />}
                    label="Conversar"
                    onClick={() => onOpen(p)}
                  />
                  <ActionButton
                    icon={<UserPlus className="size-4" />}
                    label="Adicionar"
                    onClick={() => onAdicionar(p)}
                    hint="Preencher os dados e salvar como contato"
                  />
                  <ActionButton
                    icon={<Video className="size-4" />}
                    label="Vídeo"
                    disabled
                    hint="Em breve"
                  />
                </div>
                <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
                  <b>Conversar</b> abre o 1:1 (com chat, negócio e ligação).{" "}
                  <b>Adicionar</b> salva nos contatos.
                </p>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
