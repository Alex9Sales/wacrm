'use client';

// ============================================================
// EmailApiSetupDialog — mostrado depois de criar um canal de e-mail "Meu
// provedor (API)" / BYO. Traz o webhook de entrada + o segredo pra o cliente
// apontar o inbound do provedor dele (Resend inbound, encaminhamento…) pro CRM.
// Enviar já é automático (usa o Resend do canal); só o receber precisa disso.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, CheckCircle2, MailPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface EmailApiInbound {
  webhook_url: string;
  header: string;
  secret: string;
  address: string | null;
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          toast.error('Não consegui copiar.');
        }
      }}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Copiar"
    >
      {done ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
        <code className="flex-1 break-all text-xs text-foreground">{value}</code>
        <CopyBtn text={value} />
      </div>
    </div>
  );
}

export function EmailApiSetupDialog({
  inbound,
  onClose,
}: {
  inbound: EmailApiInbound | null;
  onClose: () => void;
}) {
  const open = inbound !== null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <MailPlus className="size-4 text-primary" />
            Canal criado — configure o recebimento
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            <strong>Enviar já funciona</strong> (usa o seu provedor — Resend ou
            SMTP). Pra <strong>receber</strong>, aponte o inbound do seu provedor
            pro webhook abaixo — uma vez só.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {inbound?.address && <Row label="Endereço do canal (campo `to`)" value={inbound.address} />}
          <Row label="Webhook (POST)" value={inbound?.webhook_url ?? ''} />
          <Row label={`Header — ${inbound?.header ?? 'x-email-token'}`} value={inbound?.secret ?? ''} />

          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            ⚠️ Guarde o segredo agora — ele não é mostrado de novo. Pra cada e-mail
            que chegar no seu provedor, faça um <strong>POST</strong> pro webhook com
            esse header e o corpo JSON:
            <pre className="mt-1 overflow-x-auto rounded bg-background/60 p-2 text-[11px] text-foreground">{`{ "to": "endereço-do-canal",
  "from": "cliente@x.com",
  "subject": "...", "text": "...", "html": "..." }
// ou { "to", "from", "raw": "<MIME cru>" }`}</pre>
          </div>
        </div>

        <DialogFooter className="border-border bg-popover">
          <Button
            onClick={onClose}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Entendi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
