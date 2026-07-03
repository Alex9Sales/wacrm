'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Phase 1: invitations are gone (the peek / redeem RPCs return 501),
// and this page can no longer talk to Supabase (browser client + auth
// removed). It's now a static placeholder telling the visitor that
// invitations return in Phase 2. The route still exists so old invite
// links resolve to a friendly message instead of a 404.
//
// TODO(fase-2): restore the full accept flow (peek → sign in / sign up
// → redeem) once Better Auth + the invitation endpoints are back.
// ============================================================

import Link from 'next/link';
import { UsersRound } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function JoinPage() {
  return (
    <Card className="w-full max-w-md border-border bg-card">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <UsersRound className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl text-foreground">
          Convites voltam na Fase 2
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          O fluxo de convites está temporariamente desativado durante a
          migração. Ele retorna na Fase 2, junto com o novo login.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Link href="/login">
          <Button
            variant="outline"
            className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Voltar para o login
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
