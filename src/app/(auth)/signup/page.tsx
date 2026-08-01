"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { UsersRound, Lock } from "lucide-react";

// Cadastro FECHADO (só por convite). Clientes (donos de org) são
// provisionados no /admin; atendentes entram por convite. Não existe mais
// cadastro "frio" que cria um tenant novo — um estranho não vira cliente.
//
// Com token de convite → cria só o login (signUp.email) e manda pro
// /join/<token>, onde a pessoa aceita e entra na org existente (sem criar
// empresa — o Better Auth já bloqueia isso via allowUserToCreateOrganization).
// Sem token → tela de "cadastro por convite".

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

function SignupPageInner() {
  const searchParams = useSearchParams();
  // Vem do /join/<token>; depois do signup voltamos pro convite pra aceitar.
  const inviteToken = searchParams.get("invite");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Sem convite → cadastro fechado. Nada de formulário.
  if (!inviteToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">
              Cadastro por convite
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              O acesso ao Fluxia é liberado pela sua empresa. Peça um convite a
              quem administra sua conta, ou fale com a Fluxia para contratar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Já tenho conta — Entrar
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    if (password !== confirmPassword) {
      toast.error("As senhas não coincidem.");
      return;
    }

    setSubmitting(true);

    // Cria só o login. A org NÃO é criada aqui — o atendente entra na org do
    // convite via /join (acceptInvitation).
    const signUpRes = await authClient.signUp.email({
      name: fullName,
      email,
      password,
    });
    if (signUpRes.error) {
      toast.error(signUpRes.error.message ?? "Não foi possível criar a conta.");
      setSubmitting(false);
      return;
    }

    // Navegação completa pro convite: re-hidrata a sessão e aceita o convite.
    window.location.href = `/join/${encodeURIComponent(inviteToken)}`;
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <UsersRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Criar conta e entrar
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Crie sua conta e depois aceite o convite para entrar no time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                Nome completo
              </Label>
              <Input
                id="fullName"
                type="text"
                placeholder="João da Silva"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                disabled={submitting}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="email" className="text-muted-foreground">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={submitting}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="password" className="text-muted-foreground">
                Senha
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
              <Label htmlFor="confirmPassword" className="text-muted-foreground">
                Confirmar senha
              </Label>
              <PasswordInput
                id="confirmPassword"
                placeholder="Repita sua senha"
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
              {submitting ? "Criando conta..." : "Criar conta e entrar"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Já tem uma conta?{" "}
            <Link
              href={`/login?invite=${encodeURIComponent(inviteToken)}`}
              className="text-primary hover:text-primary/80"
            >
              Entrar
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
