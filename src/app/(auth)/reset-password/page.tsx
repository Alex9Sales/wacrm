"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { MessageSquare, ArrowLeft, KeyRound } from "lucide-react";

// Fase 2: página de destino do link de redefinição. O Better Auth
// redireciona para cá anexando `?token=<token>` (via `redirectTo` do
// requestPasswordReset). Coletamos a nova senha e chamamos
// `resetPassword({ newPassword, token })`; em caso de sucesso levamos o
// usuário de volta ao /login.

// `useSearchParams` exige uma fronteira de Suspense para não desabilitar
// o prerender estático — mesmo padrão de /login e /signup.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordPageInner />
    </Suspense>
  );
}

function ResetPasswordPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  // Better Auth pode redirecionar com `?error=INVALID_TOKEN` se o link
  // for inválido/expirado antes mesmo de chegar aqui.
  const linkError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const tokenMissing = !token || Boolean(linkError);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !token) return;

    if (password !== confirmPassword) {
      toast.error("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);

    const { error } = await authClient.resetPassword({
      newPassword: password,
      token,
    });

    if (error) {
      toast.error(
        error.message ??
          "Não foi possível redefinir a senha. O link pode ter expirado.",
      );
      setSubmitting(false);
      return;
    }

    toast.success("Senha redefinida. Entre com sua nova senha.");
    router.push("/login");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            {tokenMissing ? (
              <MessageSquare className="h-6 w-6 text-primary" />
            ) : (
              <KeyRound className="h-6 w-6 text-primary" />
            )}
          </div>
          <CardTitle className="text-xl text-foreground">
            {tokenMissing ? "Link inválido" : "Nova senha"}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {tokenMissing
              ? "Este link de redefinição é inválido ou expirou. Solicite um novo."
              : "Escolha uma nova senha para sua conta"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tokenMissing ? (
            <Link href="/forgot-password">
              <Button className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Solicitar novo link
              </Button>
            </Link>
          ) : (
            <form onSubmit={handleReset} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="password" className="text-muted-foreground">
                  Nova senha
                </Label>
                <PasswordInput
                  id="password"
                  placeholder="Pelo menos 6 caracteres"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={submitting}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label
                  htmlFor="confirmPassword"
                  className="text-muted-foreground"
                >
                  Confirmar nova senha
                </Label>
                <PasswordInput
                  id="confirmPassword"
                  placeholder="Repita a nova senha"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={submitting}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
                />
              </div>

              <Button
                type="submit"
                disabled={submitting}
                className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting ? "Redefinindo..." : "Redefinir senha"}
              </Button>
            </form>
          )}

          <Link
            href="/login"
            className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            Voltar para o login
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
