"use client";

// ============================================================
// ProvisionDialog — provision a new client (Phase 8).
//
// Two-step modal:
//   1. Form  — orgName, ownerName, ownerEmail, senha inicial, plano,
//              vencimento, billing_phone → POST /api/admin/clients.
//   2. Result — success panel with the credentials (email + senha) for
//              Alex to copy and hand over.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ProvisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProvisioned: () => void;
}

interface Credentials {
  email: string;
  password: string;
}

export function ProvisionDialog({
  open,
  onOpenChange,
  onProvisioned,
}: ProvisionDialogProps) {
  const [orgName, setOrgName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [password, setPassword] = useState("");
  const [plan, setPlan] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [billingPhone, setBillingPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Credentials | null>(null);

  function reset() {
    setOrgName("");
    setOwnerName("");
    setOwnerEmail("");
    setPassword("");
    setPlan("");
    setDueAt("");
    setBillingPhone("");
    setResult(null);
    setSubmitting(false);
  }

  async function handleCreate() {
    if (!orgName.trim() || !ownerName.trim() || !ownerEmail.trim() || !password) {
      toast.error("Nome da empresa, dono, e-mail e senha são obrigatórios.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgName: orgName.trim(),
          ownerName: ownerName.trim(),
          ownerEmail: ownerEmail.trim(),
          password,
          plan: plan.trim() || undefined,
          dueAt: dueAt || undefined,
          billingPhone: billingPhone.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || "Não foi possível provisionar o cliente.");
        return;
      }
      const data = (await res.json()) as {
        owner: { email: string };
        tempPassword: string;
      };
      setResult({ email: data.owner.email, password: data.tempPassword });
      onProvisioned();
    } catch (err) {
      console.error("[ProvisionDialog] create error:", err);
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyCredentials() {
    if (!result) return;
    const text = `Login: ${result.email}\nSenha: ${result.password}`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Credenciais copiadas.");
    } catch {
      toast.error("Não foi possível copiar — copie manualmente.");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-500" />
                Cliente provisionado
              </DialogTitle>
              <DialogDescription>
                Entregue estas credenciais ao cliente. Ele pode trocar a
                senha depois, nas configurações.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label className="text-muted-foreground">Login (e-mail)</Label>
                <Input
                  readOnly
                  value={result.email}
                  className="bg-muted font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground">Senha inicial</Label>
                <Input
                  readOnly
                  value={result.password}
                  className="bg-muted font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
                Copie agora — a senha em texto não é armazenada e não
                aparecerá novamente.
              </div>
              <Button onClick={copyCredentials} className="w-full">
                <Copy className="size-4" />
                Copiar credenciais
              </Button>
            </div>

            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Concluir</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Provisionar cliente</DialogTitle>
              <DialogDescription>
                Cria a organização, o dono e a senha inicial. As
                credenciais aparecem no final para você entregar.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Nome da empresa</Label>
                <Input
                  placeholder="ex.: Padaria do João"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Nome do dono</Label>
                  <Input
                    placeholder="ex.: João Silva"
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">E-mail</Label>
                  <Input
                    type="email"
                    placeholder="joao@empresa.com"
                    value={ownerEmail}
                    onChange={(e) => setOwnerEmail(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">Senha inicial</Label>
                <Input
                  type="text"
                  placeholder="senha para o cliente"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Plano</Label>
                  <Input
                    placeholder="ex.: Pro"
                    value={plan}
                    onChange={(e) => setPlan(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label className="text-muted-foreground">Vencimento</Label>
                  <Input
                    type="date"
                    value={dueAt}
                    onChange={(e) => setDueAt(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  Telefone de cobrança (WhatsApp)
                </Label>
                <Input
                  placeholder="ex.: 5511999999999"
                  value={billingPhone}
                  onChange={(e) => setBillingPhone(e.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Provisionando…
                  </>
                ) : (
                  "Provisionar"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
