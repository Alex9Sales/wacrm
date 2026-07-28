"use client";

// ============================================================
// CreateMemberDialog — direct team-member creation.
//
// Two steps:
//   1. Form   — name + email + password (+ generate) + role → create.
//   2. Result — the login + password to hand over (copy / WhatsApp share).
//
// Simpler than the invite-link flow: the admin sets the credentials and
// sends them to the person, who logs in with their role. They can change
// the password later in settings.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, MessageCircle, RefreshCw, UserPlus } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isStaleActionError, reloadForStaleAction } from "@/lib/stale-action";
import { createTeamMember } from "./actions";

type MemberRole = "admin" | "agent" | "viewer";

const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  admin:
    "Pode convidar/criar membros, gerenciar configurações, enviar mensagens e editar dados.",
  agent:
    "Pode usar conversas, contatos, disparos, automações e fluxos. Sem acesso a configurações ou membros.",
  viewer:
    "Acesso somente leitura em todas as páginas. Não pode enviar nem editar nada.",
};

const SITE_URL = "https://crm.salestecnologia.com.br";

function generatePassword(): string {
  // Skip ambiguous chars (0/O, 1/l/I) so a hand-typed password is painless.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

interface CreateMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent re-fetches members. */
  onCreated: () => void;
}

interface Created {
  name: string;
  email: string;
  password: string;
  role: MemberRole;
}

export function CreateMemberDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateMemberDialogProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<MemberRole>("agent");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Created | null>(null);

  function reset() {
    setName("");
    setEmail("");
    setPassword("");
    setRole("agent");
    setSubmitting(false);
    setResult(null);
  }

  async function handleCreate() {
    if (!name.trim() || !email.trim() || !password) {
      toast.error("Preencha nome, e-mail e senha.");
      return;
    }
    setSubmitting(true);
    try {
      await createTeamMember({ name, email, password, role });
      setResult({ name: name.trim(), email: email.trim().toLowerCase(), password, role });
      onCreated();
    } catch (err) {
      if (isStaleActionError(err)) {
        toast.info("Atualizando o sistema…");
        reloadForStaleAction();
        return;
      }
      toast.error(err instanceof Error ? err.message : "Não foi possível criar o membro.");
    } finally {
      setSubmitting(false);
    }
  }

  const credentialsText = (r: Created) =>
    `Seu acesso ao FluxiaCRM:\nSite: ${SITE_URL}\nLogin: ${r.email}\nSenha: ${r.password}\n\nEntre e, se quiser, troque a senha em Configurações › Login e segurança.`;

  async function copyCredentials() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(credentialsText(result));
      toast.success("Credenciais copiadas");
    } catch {
      toast.error("Área de transferência bloqueada — copie manualmente");
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
      <DialogContent className="bg-popover border-border sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <UserPlus className="size-4 text-primary" />
                Membro criado
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Envie estes dados para <span className="font-medium">{result.name}</span>.
                Ela(e) entra no site com esse login e senha e já acessa como{" "}
                <span className="font-medium">{result.role}</span>.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Site</span>
                  <span className="font-mono text-xs">{SITE_URL}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Login</span>
                  <span className="font-mono text-xs">{result.email}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Senha</span>
                  <span className="font-mono text-xs">{result.password}</span>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={copyCredentials}
                  className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  <Copy className="size-4" />
                  Copiar dados
                </Button>
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(credentialsText(result))}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={buttonVariants({
                    variant: "outline",
                    className: "flex-1 border-border text-muted-foreground hover:bg-muted",
                  })}
                >
                  <MessageCircle className="size-4" />
                  WhatsApp
                </a>
              </div>

              <div className="rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
                <strong className="font-semibold text-amber-100">
                  Copie a senha agora.
                </strong>{" "}
                Ela não fica visível depois. Se perder, você pode redefinir criando outra ou pedindo à pessoa para usar "esqueci a senha".
              </div>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                onClick={() => onOpenChange(false)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                Concluído
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                Criar membro
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Crie o acesso com login e senha e mande para a pessoa. Sem
                depender de e-mail de convite.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="m-name" className="text-muted-foreground">Nome</Label>
                <Input
                  id="m-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Nome da pessoa"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="m-email" className="text-muted-foreground">E-mail (login)</Label>
                <Input
                  id="m-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="pessoa@empresa.com"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="m-pass" className="text-muted-foreground">Senha</Label>
                <div className="flex gap-2">
                  <Input
                    id="m-pass"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Mínimo 8 caracteres"
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPassword(generatePassword())}
                    title="Gerar senha"
                    className="shrink-0 border-border text-muted-foreground hover:bg-muted"
                  >
                    <RefreshCw className="size-4" />
                    Gerar
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-muted-foreground">Perfil</Label>
                <Select value={role} onValueChange={(v) => v && setRole(v as MemberRole)}>
                  <SelectTrigger className="w-full bg-muted border-border text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="agent">Atendente</SelectItem>
                    <SelectItem value="viewer">Visualizador</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {ROLE_DESCRIPTIONS[role]}
                </p>
              </div>
            </div>

            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Criando...
                  </>
                ) : (
                  "Criar membro"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
