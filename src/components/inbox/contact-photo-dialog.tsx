"use client";

// ============================================================
// Clicar no avatar do contato abre a foto GRANDE com os dados, igual ao
// WhatsApp (pedido do Rafael, 03/09). Mesma ideia do painel de participante de
// grupo (participant-action-sheet), mas pro 1:1: foto, nome, código(s) do
// cliente, telefone com copiar, e-mail e empresa.
//
// Sem foto, mostra a inicial grande — nunca um quadrado quebrado.
// ============================================================

import { Copy, Mail, Phone, Building2 } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ContactPhotoInfo {
  name: string;
  avatarUrl?: string | null;
  phone?: string | null;
  email?: string | null;
  company?: string | null;
  customerCodes?: string[] | null;
}

interface ContactPhotoDialogProps {
  contact: ContactPhotoInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function copy(label: string, value: string) {
  navigator.clipboard
    .writeText(value)
    .then(() => toast.success(`${label} copiado`))
    .catch(() => toast.error("Não deu para copiar"));
}

export function ContactPhotoDialog({
  contact,
  open,
  onOpenChange,
}: ContactPhotoDialogProps) {
  if (!contact) return null;
  const name = contact.name || contact.phone || "Contato";
  const codes = (contact.customerCodes ?? []).filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0 overflow-hidden">
        <DialogHeader className="sr-only">
          <DialogTitle>Foto de {name}</DialogTitle>
        </DialogHeader>

        {/* Foto grande — quadrada, do jeito que o WhatsApp abre. */}
        <div className="flex aspect-square w-full items-center justify-center bg-muted">
          {contact.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={contact.avatarUrl}
              alt={name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-7xl font-semibold text-muted-foreground">
              {name.charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{name}</h2>
            {codes.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {codes.map((code) => (
                  <span
                    key={code}
                    className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary"
                    title="Código do cliente"
                  >
                    #{code}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {contact.phone ? (
            <button
              type="button"
              onClick={() => copy("Telefone", contact.phone!)}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <span className="flex items-center gap-2 text-foreground">
                <Phone className="h-4 w-4 text-muted-foreground" />
                {contact.phone}
              </span>
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ) : null}

          {contact.email ? (
            <button
              type="button"
              onClick={() => copy("E-mail", contact.email!)}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted"
            >
              <span className="flex min-w-0 items-center gap-2 text-foreground">
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </span>
              <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          ) : null}

          {contact.company ? (
            <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground">
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{contact.company}</span>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
