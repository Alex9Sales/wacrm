"use client";

// ============================================================
// Fase 2 — Cadastro de TESTE GRÁTIS (self-serve). Diferente do /signup (que é só
// por convite), aqui cria uma ORG NOVA em trial de 7 dias: signUp.email → cria o
// login → /api/trial/provision cria a org+billing(trial) → setActive → dashboard.
// ============================================================

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { VerifyEmailNotice } from "@/components/auth/verify-email-notice";
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
import { Sparkles } from "lucide-react";

export default function ComecarPage() {
  const [fullName, setFullName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [website, setWebsite] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (password.length < 6) {
      toast.error("A senha precisa ter pelo menos 6 caracteres.");
      return;
    }
    setSubmitting(true);
    try {
      // Login + empresa de teste em UMA chamada (servidor). O cadastro só
      // entra depois de confirmar o e-mail — a tela seguinte explica.
      const res = await fetch("/api/trial/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fullName,
          email,
          password,
          orgName: company.trim() || fullName,
          website, // honeypot (fica vazio pra humanos)
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Não foi possível criar a conta.");
        setSubmitting(false);
        return;
      }
      setSent(true);
      setSubmitting(false);
    } catch {
      toast.error("Não foi possível criar a conta.");
      setSubmitting(false);
    }
  };

  if (sent) {
    return <VerifyEmailNotice email={email} callbackURL="/dashboard" />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Sparkles className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Comece grátis por 7 dias
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Sem cartão de crédito. Configure em minutos e veja a IA atendendo hoje.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* honeypot: humano não vê nem preenche */}
            <input
              type="text"
              name="website"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              style={{ position: "absolute", left: "-9999px", width: 1, height: 1, opacity: 0 }}
            />
            <div className="flex flex-col gap-2">
              <Label htmlFor="fullName" className="text-muted-foreground">
                Seu nome
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
              <Label htmlFor="company" className="text-muted-foreground">
                Nome da empresa
              </Label>
              <Input
                id="company"
                type="text"
                placeholder="Minha Empresa Ltda"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
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

            <Button
              type="submit"
              disabled={submitting}
              className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? "Criando sua conta..." : "Começar teste grátis"}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            Já tem uma conta?{" "}
            <Link href="/login" className="text-primary hover:text-primary/80">
              Entrar
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
