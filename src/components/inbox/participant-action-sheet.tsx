"use client";

// ============================================================
// ParticipantActionSheet — clicar no avatar de um participante num thread de
// GRUPO abre este painel (tipo WhatsApp): foto + nome + número, com as ações
// Conversar / Voz / Vídeo / Adicionar. O telefone vem do `author_key` da
// mensagem (a CRM já guarda o número puro do remetente do grupo).
// ============================================================

import { MessageSquare, Phone, Video, UserPlus, Copy, Loader2 } from "lucide-react";
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
  /** Ligações só aparecem habilitadas quando o CRM calling está ligado. */
  callingEnabled: boolean;
  busy: boolean;
  onConversar: (p: GroupParticipant) => void;
  onVoz: (p: GroupParticipant) => void;
  onAdicionar: (p: GroupParticipant) => void;
}

/** "+55 67 99187-5477" a partir de "556791875477" (best-effort BR). */
function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    const mid = rest.length === 9 ? `${rest.slice(0, 5)}-${rest.slice(5)}` : `${rest.slice(0, 4)}-${rest.slice(4)}`;
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
  callingEnabled,
  busy,
  onConversar,
  onVoz,
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
              <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Abrindo…
              </div>
            ) : (
              <div className="mt-1 grid w-full grid-cols-4 gap-2">
                <ActionButton
                  primary
                  icon={<MessageSquare className="size-4" />}
                  label="Conversar"
                  onClick={() => onConversar(p)}
                />
                <ActionButton
                  icon={<Phone className="size-4" />}
                  label="Voz"
                  onClick={callingEnabled ? () => onVoz(p) : undefined}
                  disabled={!callingEnabled}
                  hint={callingEnabled ? "Ligar" : "Ligações não habilitadas nesta conta"}
                />
                <ActionButton
                  icon={<Video className="size-4" />}
                  label="Vídeo"
                  disabled
                  hint="Em breve"
                />
                <ActionButton
                  icon={<UserPlus className="size-4" />}
                  label="Adicionar"
                  onClick={() => onAdicionar(p)}
                  hint="Adicionar aos contatos"
                />
              </div>
            )}
            <p className="text-center text-[11px] text-muted-foreground">
              &quot;Conversar&quot; abre um 1:1 pelo mesmo canal e já cria o contato.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
