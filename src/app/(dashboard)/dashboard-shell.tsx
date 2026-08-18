"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, LogOut, Clock3, Gift } from "lucide-react";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { NotificationListener } from "@/components/notifications/notification-listener";
import { ChannelStatusBanner } from "@/components/channels/channel-status-banner";
import { IncomingCallModal } from "@/components/calls/incoming-call-modal";
import { VoiceLiveBadge } from "@/components/calls/voice-live-badge";
import { SubscribeButton } from "@/components/billing/subscribe-dialog";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const {
    user,
    loading,
    profileLoading,
    suspended,
    trialActive,
    trialEndsAt,
    trialExpired,
    signOut,
  } = useAuth();
  const trialDaysLeft =
    trialActive && trialEndsAt
      ? Math.max(
          0,
          Math.ceil(
            (new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000,
          ),
        )
      : null;
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Carregando…</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Phase 8: the active org's billing is 'suspended'. getCurrentAccount
  // throws AccountSuspendedError, so every org-scoped page would break —
  // show a friendly full-page notice instead. Platform admins operate via
  // /admin (a separate layout) and are never suspended here.
  if (!profileLoading && suspended) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <Ban className="size-7" />
        </div>
        <div className="max-w-md space-y-2">
          <h1 className="font-heading text-xl font-semibold text-foreground">
            Sua conta está suspensa
          </h1>
          <p className="text-sm text-muted-foreground">
            O acesso à sua conta foi temporariamente pausado. Para
            reativá-la, fale com a Fluxia e regularize a sua assinatura.
          </p>
        </div>
        <button
          type="button"
          onClick={signOut}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <LogOut className="size-4" />
          Sair
        </button>
      </div>
    );
  }

  // Fase 2: trial expirado — tela amigável com o checkout (Asaas).
  if (!profileLoading && trialExpired) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Clock3 className="size-7" />
        </div>
        <div className="max-w-md space-y-2">
          <h1 className="font-heading text-xl font-semibold text-foreground">
            Seu teste grátis terminou
          </h1>
          <p className="text-sm text-muted-foreground">
            Esperamos que tenha curtido o FluxiaCRM! Para continuar atendendo e
            vendendo com a plataforma, assine um plano — leva menos de 1 minuto,
            com Pix, boleto ou cartão.
          </p>
        </div>
        <div className="flex flex-col items-center gap-3">
          <SubscribeButton label="Assinar agora" />
          <div className="flex items-center gap-3 text-xs">
            <a
              href="https://wa.me/556791806048?text=Quero%20assinar%20o%20FluxiaCRM"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground underline transition hover:text-foreground"
            >
              Falar com a Fluxia
            </a>
            <button
              type="button"
              onClick={signOut}
              className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <LogOut className="size-3.5" />
              Sair
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <NotificationListener />
      {/* Global incoming WhatsApp voice call — rings + answers (WebRTC). */}
      <IncomingCallModal />
      {/* Floating "IA em atendimento" pill while the AI voice agent is on a call. */}
      <VoiceLiveBadge />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Global heads-up when a WhatsApp channel's session drops, with a
            one-click re-pair (QR). Renders nothing while all are connected. */}
        <ChannelStatusBanner />
        {/* Fase 2: faixa do teste grátis com os dias restantes. */}
        {trialDaysLeft !== null && (
          <div className="flex items-center justify-center gap-2 bg-primary/10 px-4 py-1.5 text-center text-xs font-medium text-primary">
            <Gift className="h-3.5 w-3.5" />
            {trialDaysLeft > 0 ? (
              <span>
                Teste grátis — {trialDaysLeft}{' '}
                {trialDaysLeft === 1 ? 'dia restante' : 'dias restantes'}. Aproveite
                todos os recursos!
              </span>
            ) : (
              <span>Seu teste grátis termina hoje. Assine para não perder o acesso.</span>
            )}
            <SubscribeButton
              label="Assinar"
              className="ml-1 h-6 px-2.5 text-xs"
            />
          </div>
        )}
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
