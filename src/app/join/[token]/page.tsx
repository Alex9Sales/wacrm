'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Fase 2: fluxo completo de aceite de convite sobre Better Auth
// organizations. `token` (do path) = invitation.id.
//
// Fluxo:
//   1. peek — GET /api/invitations/[token]/peek retorna metadados do
//      convite (org, email convidado, role, status, expiresAt). Trata
//      404 / expirado / já usado com mensagem amigável.
//   2. Se o visitante ESTÁ logado (authClient.useSession) → botão
//      "Aceitar convite para <org>" chamando
//      authClient.organization.acceptInvitation({ invitationId }).
//      Em sucesso: setActive(org) + redireciona /dashboard.
//   3. Se NÃO está logado → CTAs para /login?invite=<token> e
//      /signup?invite=<token>; após autenticar, as páginas de auth
//      retornam para cá e o passo 2 assume.
// ============================================================

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, UsersRound } from 'lucide-react';

import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

// Contrato do GET /api/invitations/[token]/peek (implementado nesta
// onda por outro agente). Campos opcionais/permissivos para tolerar
// pequenas variações de nomenclatura no shape retornado.
interface InvitePeek {
  organizationName?: string;
  organizationSlug?: string;
  email?: string;
  role?: string;
  status?: string;
  expiresAt?: string;
}

type PeekState =
  | { kind: 'loading' }
  | { kind: 'ok'; invite: InvitePeek }
  | { kind: 'error'; message: string };

export default function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  const { data: session, isPending: sessionPending } = authClient.useSession();
  const isSignedIn = Boolean(session?.user);

  const [peek, setPeek] = useState<PeekState>({ kind: 'loading' });
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  // ---- peek ------------------------------------------------
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/invitations/${encodeURIComponent(token)}/peek`,
          { cache: 'no-store' },
        );

        if (!active) return;

        if (res.status === 404) {
          setPeek({
            kind: 'error',
            message: 'Convite não encontrado. O link pode estar incorreto.',
          });
          return;
        }
        if (!res.ok) {
          setPeek({
            kind: 'error',
            message:
              'Não foi possível carregar o convite. Tente novamente mais tarde.',
          });
          return;
        }

        const invite = (await res.json()) as InvitePeek;

        // Convites expirados / já aceitos / cancelados.
        const expired =
          invite.expiresAt && new Date(invite.expiresAt).getTime() < Date.now();
        const status = invite.status?.toLowerCase();
        if (expired || (status && status !== 'pending')) {
          setPeek({
            kind: 'error',
            message:
              status && status === 'accepted'
                ? 'Este convite já foi aceito.'
                : 'Este convite expirou ou não está mais disponível.',
          });
          return;
        }

        setPeek({ kind: 'ok', invite });
      } catch {
        if (active) {
          setPeek({
            kind: 'error',
            message:
              'Não foi possível carregar o convite. Verifique sua conexão.',
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  // ---- accept ----------------------------------------------
  const handleAccept = useCallback(async () => {
    if (accepting) return;
    setAccepting(true);
    setAcceptError(null);

    const { data, error } = await authClient.organization.acceptInvitation({
      invitationId: token,
    });

    if (error || !data) {
      setAcceptError(
        error?.message ??
          'Não foi possível aceitar o convite. Ele pode ter expirado.',
      );
      setAccepting(false);
      return;
    }

    // Seta a org do convite como ativa antes de entrar no dashboard.
    const organizationId =
      data.invitation?.organizationId ?? data.member?.organizationId;
    if (organizationId) {
      await authClient.organization.setActive({ organizationId });
    }

    // Navegação completa para re-hidratar o AuthProvider a partir de
    // /api/me com a nova organização ativa.
    window.location.href = '/dashboard';
  }, [accepting, token]);

  // ---- render ----------------------------------------------
  if (peek.kind === 'loading' || sessionPending) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 py-10">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Carregando convite...</p>
        </CardContent>
      </Card>
    );
  }

  if (peek.kind === 'error') {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <UsersRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            Convite indisponível
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {peek.message}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Link href="/login">
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Ir para o login
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  const orgName = peek.invite.organizationName ?? 'sua equipe';

  return (
    <Card className="w-full max-w-md border-border bg-card">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <UsersRound className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl text-foreground">
          Convite para {orgName}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {isSignedIn
            ? `Você foi convidado para entrar em ${orgName}.`
            : `Você foi convidado para entrar em ${orgName}. Entre ou crie uma conta para aceitar.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {isSignedIn ? (
          <>
            <Button
              onClick={handleAccept}
              disabled={accepting}
              className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {accepting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Aceitando...
                </>
              ) : (
                `Aceitar convite para ${orgName}`
              )}
            </Button>
            {acceptError && (
              <p className="text-center text-sm text-destructive">
                {acceptError}
              </p>
            )}
          </>
        ) : (
          <>
            <Link href={`/login?invite=${encodeURIComponent(token)}`}>
              <Button className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90">
                Entrar para aceitar
              </Button>
            </Link>
            <Link href={`/signup?invite=${encodeURIComponent(token)}`}>
              <Button
                variant="outline"
                className="h-10 w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Criar conta
              </Button>
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}
