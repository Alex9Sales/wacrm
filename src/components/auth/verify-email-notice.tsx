"use client";

// ============================================================
// "Confirme seu e-mail" — mostrado depois do cadastro (trial e convite) e no
// login quando a conta ainda não foi confirmada. Botão de reenviar com
// intervalo de 30s (o Better Auth também limita por IP).
// ============================================================

import { useEffect, useState } from "react";
import { MailCheck } from "lucide-react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const RESEND_COOLDOWN_S = 30;

export function VerifyEmailNotice({
  email,
  callbackURL,
  title = "Confirme seu e-mail",
}: {
  email: string;
  /** Pra onde o link do e-mail leva depois de confirmar (já logado). */
  callbackURL: string;
  title?: string;
}) {
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = async () => {
    if (sending || cooldown > 0) return;
    setSending(true);
    const { error } = await authClient.sendVerificationEmail({ email, callbackURL });
    setSending(false);
    if (error) {
      toast.error(error.message ?? "Não foi possível reenviar agora. Tente de novo em instantes.");
      return;
    }
    toast.success("Link reenviado. Confira a caixa de entrada e o spam.");
    setCooldown(RESEND_COOLDOWN_S);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <MailCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">{title}</CardTitle>
          <CardDescription className="text-muted-foreground">
            Enviamos um link para <span className="font-medium text-foreground">{email}</span>.
            Abra o e-mail e clique em <strong>Confirmar e-mail</strong> — você já entra logado.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-center text-sm text-muted-foreground">
            Não chegou? Olhe a pasta de spam. O link vale por 24 horas.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={resend}
            disabled={sending || cooldown > 0}
            className="w-full"
          >
            {sending
              ? "Reenviando…"
              : cooldown > 0
                ? `Reenviar e-mail (${cooldown}s)`
                : "Reenviar e-mail"}
          </Button>
          <a href="/login" className="text-center text-sm text-primary hover:underline">
            Voltar ao login
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
