"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./actions";
import type { Notification } from "@/types";
import { Bell, CheckCheck, Loader2, UserPlus, Clock, AtSign, ArrowRightLeft, ListChecks, CalendarClock, Sparkles } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Icon per notification type.
const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  conversation_assigned: UserPlus,
  sla_alert: Clock,
  mention: AtSign,
  deal_transferred: ArrowRightLeft,
  task_assigned: ListChecks,
  deal_ai_suggestion: Sparkles,
  scheduled_message_assigned: CalendarClock,
};

export default function NotificationsPage() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);

  const load = useCallback(async () => {
    try {
      // Account + recipient scoping happens inside the server action.
      const data = await listNotifications();
      setNotifications(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Falha ao carregar notificações",
      );
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // TODO(fase-3): the Supabase realtime subscription that kept this
  // list live (new assignments appearing without a refresh, cross-tab
  // "mark all read" sync) was removed with the Supabase client. Restore
  // via the SSE channel in Phase 3.

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic — the row is already visually "read" by the time the
      // request lands, so the UI doesn't wait on the round-trip.
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n,
          ) ?? prev,
      );
      const { error: updateErr } = await markNotificationRead(id);
      if (updateErr) {
        toast.error("Falha ao marcar notificação como lida");
        load();
      }
    },
    [load],
  );

  const handleClick = useCallback(
    async (n: Notification) => {
      // Tarefa atribuída → abre a lista de tarefas (independe de ter negócio).
      if (n.type === "task_assigned") {
        if (!n.read_at) markRead(n.id);
        router.push("/tarefas");
        return;
      }
      // Mensagem agendada atribuída → abre a central de Agendamentos (mesmo
      // tendo conversation_id, o destino certo é a lista, não o inbox).
      if (n.type === "scheduled_message_assigned") {
        if (!n.read_at) markRead(n.id);
        router.push("/agendamentos");
        return;
      }
      if (n.deal_id) {
        // Transferência de lead → abre o negócio. Persiste "lido" antes (a
        // navegação descarrega a página e cancelaria um fire-and-forget).
        if (!n.read_at) {
          setNotifications(
            (prev) =>
              prev?.map((x) =>
                x.id === n.id && !x.read_at
                  ? { ...x, read_at: new Date().toISOString() }
                  : x,
              ) ?? prev,
          );
          await markNotificationRead(n.id).catch(() => {});
        }
        window.location.href = `/pipelines/${n.deal_id}`;
        return;
      }
      if (n.conversation_id) {
        // FULL navigation (not router.push): the client-side push wasn't
        // reliably re-triggering the inbox's `?c=` deep-link effect, so the
        // wrong thread opened. window.location guarantees a fresh inbox mount
        // that selects the right conversation. Persist the "read" FIRST —
        // the page unloads immediately and would cancel a fire-and-forget
        // request.
        if (!n.read_at) {
          setNotifications(
            (prev) =>
              prev?.map((x) =>
                x.id === n.id && !x.read_at
                  ? { ...x, read_at: new Date().toISOString() }
                  : x,
              ) ?? prev,
          );
          await markNotificationRead(n.id).catch(() => {});
        }
        window.location.href = `/inbox?c=${n.conversation_id}`;
        return;
      }
      if (!n.read_at) markRead(n.id);
      if (n.channel_id) {
        // Menção num canal do chat interno → abre direto naquele canal.
        router.push(`/internal-chat?channel=${n.channel_id}`);
      } else if (n.type === "mention") {
        router.push(`/internal-chat`);
      }
    },
    [markRead, router],
  );

  const unreadIds = notifications?.filter((n) => !n.read_at).map((n) => n.id) ?? [];

  const markAllRead = useCallback(async () => {
    if (unreadIds.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    setNotifications(
      (prev) => prev?.map((n) => (n.read_at ? n : { ...n, read_at: now })) ?? prev,
    );
    const { error: updateErr } = await markAllNotificationsRead();
    setMarkingAll(false);
    if (updateErr) {
      toast.error("Falha ao marcar todas como lidas");
      load();
    }
  }, [unreadIds.length, load]);

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Notificações</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Conversas que outros colegas de equipe atribuem a você aparecem aqui.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={unreadIds.length === 0 || markingAll}
          onClick={markAllRead}
        >
          {markingAll ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CheckCheck className="h-4 w-4" />
          )}
          Marcar todas como lidas
        </Button>
      </div>

      {notifications.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <Bell className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">
            Nenhuma notificação ainda
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Você verá um alerta aqui quando alguém atribuir uma conversa a você.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {notifications.map((n) => {
            const Icon = TYPE_ICON[n.type] ?? Bell;
            const isUnread = !n.read_at;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => handleClick(n)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors",
                    isUnread
                      ? "border-primary/30 bg-primary/5 hover:border-primary/50"
                      : "border-border bg-card hover:border-border/70",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg",
                      isUnread ? "bg-primary/15" : "bg-muted",
                    )}
                    aria-hidden
                  >
                    <Icon
                      className={cn(
                        "h-5 w-5",
                        isUnread ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "truncate text-sm font-semibold",
                          isUnread ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {n.title}
                      </span>
                      {isUnread && (
                        <span
                          aria-label="Não lidas"
                          className="h-2 w-2 flex-shrink-0 rounded-full bg-primary"
                        />
                      )}
                    </div>
                    {n.body && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {n.body}
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground/70">
                      {formatDistanceToNow(new Date(n.created_at), {
                        addSuffix: true,
                        locale: ptBR,
                      })}
                    </p>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
