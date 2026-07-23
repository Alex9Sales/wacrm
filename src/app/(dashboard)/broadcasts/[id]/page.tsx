'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  deleteBroadcast,
  getBroadcast,
  listBroadcastRecipients,
  pauseBroadcastAction,
  resumeBroadcastAction,
  cancelBroadcastAction,
  sendBroadcastNowAction,
  retryFailedBroadcastAction,
} from '../actions';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  Pause,
  Play,
  Ban,
  CalendarClock,
  Zap,
  RefreshCw,
  MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
} from '@/lib/broadcast-status';

/**
 * Poll cadence while the broadcast is still moving. The queue worker
 * advances counts server-side; we just surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 3_000;

/** Statuses that are still in motion — polling stays on while in one. */
const LIVE_STATUSES = new Set(['scheduled', 'sending', 'paused']);

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

/**
 * Pure-CSS funnel chart: decreasing-width rounded bars.
 * Width is relative to the largest step (typically Sent) so we
 * always render a full bar at the top and proportional tails.
 */
function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">Funil</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
];

/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    const bc = await getBroadcast(broadcastId);
    if (!bc) throw new Error('Disparo não encontrado');
    setBroadcast(bc);
    const recs = await listBroadcastRecipients(broadcastId);
    setRecipients(recs);
    return bc;
  }, [broadcastId]);

  useEffect(() => {
    fetchData()
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Falha ao carregar o disparo'),
      )
      .finally(() => setLoading(false));
  }, [fetchData]);

  // Live polling while the broadcast is scheduled / sending / paused. Stop
  // once it reaches a terminal state (sent / failed / cancelled) so we
  // don't keep hammering the DB. Pauses while the tab is hidden.
  const isLive = broadcast ? LIVE_STATUSES.has(broadcast.status) : false;

  useEffect(() => {
    function start() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(() => {
        fetchData().catch(() => {
          /* transient — keep the last good snapshot */
        });
      }, POLL_INTERVAL_MS);
    }
    function stop() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        stop();
      } else if (isLive) {
        fetchData().catch(() => {});
        start();
      }
    }

    if (isLive && document.visibilityState === 'visible') {
      start();
    } else {
      stop();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isLive, fetchData]);

  async function runControl(
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<void> {
    setControlBusy(true);
    try {
      const fn =
        action === 'pause'
          ? pauseBroadcastAction
          : action === 'resume'
            ? resumeBroadcastAction
            : cancelBroadcastAction;
      const result = await fn(broadcastId);
      if (!result.ok) {
        toast.error(
          result.message ??
            (result.code === 'not_found'
              ? 'Broadcast não encontrado.'
              : 'Não foi possível alterar o status.'),
        );
      } else {
        const msg =
          action === 'pause'
            ? 'Broadcast pausado.'
            : action === 'resume'
              ? 'Broadcast retomado.'
              : 'Broadcast cancelado.';
        toast.success(msg);
      }
      await fetchData().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na operação.');
    } finally {
      setControlBusy(false);
    }
  }

  async function runRetryFailed(): Promise<void> {
    setControlBusy(true);
    try {
      const result = await retryFailedBroadcastAction(broadcastId);
      if (!result.ok) {
        toast.error(result.message ?? 'Não foi possível reenviar os falhados.');
      } else {
        toast.success(
          `Reenviando ${result.requeued ?? 0} destinatário(s) falhado(s).`,
        );
      }
      await fetchData().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na operação.');
    } finally {
      setControlBusy(false);
    }
  }

  async function runSendNow(): Promise<void> {
    setControlBusy(true);
    try {
      const result = await sendBroadcastNowAction(broadcastId);
      if (!result.ok) {
        toast.error(result.error ?? 'Não foi possível enviar agora.');
      } else {
        toast.success('Enviando agora — os contatos pendentes vão sair já.');
      }
      await fetchData().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha na operação.');
    } finally {
      setControlBusy(false);
    }
  }

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  function handleExport() {
    if (!broadcast) return;
    const header = [
      'Contato',
      'Telefone',
      'Status',
      'Enviada em',
      'Entregue em',
      'Lida em',
      'Respondida em',
      'Erro',
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.replied_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  async function handleDelete() {
    setDeleting(true);
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await deleteBroadcast(broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(`Falha ao excluir: ${delErr}`);
      return;
    }
    toast.success('Disparo excluído');
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? 'Disparo não encontrado'}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          Voltar para Disparos
        </Button>
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);

  // Control availability, mirroring the queue state machine:
  //   sending          → Pause, Cancel
  //   paused           → Resume, Cancel
  //   scheduled        → Cancel
  const canPause = broadcast.status === 'sending';
  const canResume = broadcast.status === 'paused';
  const canCancel =
    broadcast.status === 'sending' ||
    broadcast.status === 'scheduled' ||
    broadcast.status === 'paused';
  const deleteBlocked = isLive; // scheduled / sending / paused
  // "Enviar agora" only for a humanized drip still waiting on its slots
  // (pacing present). Bursts (pacing null) already send immediately.
  const canSendNow =
    (broadcast as unknown as { pacing?: unknown }).pacing != null &&
    (broadcast.status === 'sending' ||
      broadcast.status === 'scheduled' ||
      broadcast.status === 'paused');

  const processed =
    broadcast.sent_count + broadcast.failed_count;
  const progressPct =
    broadcast.total_recipients > 0
      ? Math.round((processed / broadcast.total_recipients) * 100)
      : 0;
  const scheduledLabel = broadcast.scheduled_at
    ? new Date(broadcast.scheduled_at).toLocaleString('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : null;

  const funnelSteps: FunnelStep[] = [
    { label: 'Enviadas', value: broadcast.sent_count, color: 'bg-primary' },
    { label: 'Entregues', value: broadcast.delivered_count, color: 'bg-teal-500' },
    { label: 'Lidas', value: broadcast.read_count, color: 'bg-blue-500' },
    { label: 'Respondidas', value: broadcast.replied_count, color: 'bg-indigo-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-border"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {status.label}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
              <span>Template: {broadcast.template_name}</span>
              <span>-</span>
              <span>
                Criado em {new Date(broadcast.created_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* "Enviar agora" — force a humanized drip to fire its pending
              recipients immediately (skip the business-hours slots). */}
          {canSendNow && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlBusy}
              onClick={() => runSendNow()}
              className="border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              <Zap className="h-3.5 w-3.5" />
              Enviar agora
            </Button>
          )}

          {/* Reenviar falhados — requeue only the failed recipients (e.g.
              the channel dropped mid-broadcast and reconnected). Shown
              whenever there are failures and a retry is valid — INCLUDING
              while 'sending', so a channel that dropped mid-send can be
              retried the moment it reconnects, without pausing first. Only
              'scheduled' has nothing to retry (retryFailedBroadcast rejects
              it). */}
          {broadcast.failed_count > 0 && broadcast.status !== 'scheduled' && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlBusy}
              onClick={() => void runRetryFailed()}
              className="border-amber-500/40 text-amber-600 hover:bg-amber-500/10 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reenviar falhados ({broadcast.failed_count})
            </Button>
          )}

          {/* Lifecycle controls — pause / resume / cancel. Visibility
              follows the queue state machine. */}
          {canPause && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlBusy}
              onClick={() => runControl('pause')}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Pause className="h-3.5 w-3.5" />
              Pausar
            </Button>
          )}
          {canResume && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlBusy}
              onClick={() => runControl('resume')}
              className="border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              Retomar
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outline"
              size="sm"
              disabled={controlBusy}
              onClick={() => setConfirmCancel(true)}
              className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-50"
            >
              <Ban className="h-3.5 w-3.5" />
              Cancelar
            </Button>
          )}

          {/* Delete — inline-confirm pattern matches the pipeline-settings
              "Delete Pipeline" flow. In-flight broadcasts (scheduled /
              sending / paused) can't be deleted because orphaning queued
              Meta sends would leave the funnel inconsistent. */}
          {confirmDelete ? (
            <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
              <span className="text-red-300">Excluir este broadcast?</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? 'Excluindo…' : 'Confirmar'}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={deleteBlocked}
              onClick={() => setConfirmDelete(true)}
              title={
                deleteBlocked
                  ? 'Não é possível excluir enquanto o broadcast está agendado, enviando ou pausado'
                  : 'Excluir este broadcast'
              }
              className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Excluir
            </Button>
          )}
        </div>
      </div>

      {/* Live progress / scheduled banner. Shows a progress bar while
          sending or paused, and the scheduled time when scheduled. */}
      {(isLive || broadcast.status === 'sent') && (
        <div className="rounded-xl border border-border bg-card p-4">
          {broadcast.status === 'scheduled' ? (
            <div className="flex items-center gap-2 text-sm text-blue-400">
              <CalendarClock className="h-4 w-4" />
              <span className="font-medium">Agendado</span>
              {scheduledLabel && (
                <span className="text-muted-foreground">
                  para {scheduledLabel}
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {broadcast.status === 'sending' && (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  )}
                  {broadcast.status === 'paused' && (
                    <Pause className="h-4 w-4 text-amber-400" />
                  )}
                  <span>
                    {broadcast.status === 'sending'
                      ? 'Enviando…'
                      : broadcast.status === 'paused'
                        ? 'Pausado'
                        : 'Concluído'}
                  </span>
                  <span className="text-muted-foreground">
                    {processed.toLocaleString('pt-BR')} de{' '}
                    {broadcast.total_recipients.toLocaleString('pt-BR')} processados
                  </span>
                </div>
                <span className="text-xs font-medium text-primary tabular-nums">
                  {progressPct}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    broadcast.status === 'paused' ? 'bg-amber-400' : 'bg-primary'
                  }`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Stats — 6 cards: Total / Sent / Delivered / Read / Replied / Failed */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Total de destinatários"
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label="Enviadas"
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label="Entregues"
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label="Lidas"
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label="Respondidas"
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label="Falhas"
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Recipients Table */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            Destinatários ({filteredRecipients.length}
            {statusFilter !== 'all' ? ` de ${recipients.length}` : ''})
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? 'Todos os status'
                  : getRecipientStatus(statusFilter).label}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  Todos os status
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={
                      statusFilter === s
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {getRecipientStatus(s).label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={recipients.length === 0}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              Exportar CSV
            </Button>
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {recipients.length === 0
                ? 'Nenhum destinatário encontrado.'
                : 'Nenhum destinatário corresponde a este filtro.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">Contato</TableHead>
                  <TableHead className="text-muted-foreground">Telefone</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground">Enviada</TableHead>
                  <TableHead className="text-muted-foreground">Entregue</TableHead>
                  <TableHead className="text-muted-foreground">Lida</TableHead>
                  <TableHead className="text-muted-foreground">Erro</TableHead>
                  <TableHead className="text-muted-foreground text-right">Chat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRecipients.map((recipient) => {
                  const rStatus = getRecipientStatus(recipient.status);
                  return (
                    <TableRow key={recipient.id} className="border-border">
                      <TableCell className="font-medium text-foreground">
                        {recipient.contact?.name ?? 'Desconhecido'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.contact?.phone ?? '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                        >
                          {rStatus.label}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.sent_at
                          ? new Date(recipient.sent_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.delivered_at
                          ? new Date(recipient.delivered_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.read_at
                          ? new Date(recipient.read_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-red-400">
                        {recipient.error_message ?? '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        {recipient.conversation_id ? (
                          <button
                            type="button"
                            onClick={() =>
                              router.push(
                                `/inbox?c=${recipient.conversation_id}`,
                              )
                            }
                            title="Abrir a conversa deste contato"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/10"
                          >
                            <MessageSquare className="h-4 w-4" />
                          </button>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Cancel confirmation — cancelling is terminal: pending recipients
          won't be sent. */}
      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              Cancelar broadcast
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Tem certeza que deseja cancelar este broadcast? Os contatos
              ainda não enviados não receberão a mensagem. Esta ação não pode
              ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmCancel(false)}
              disabled={controlBusy}
              className="border-border text-muted-foreground"
            >
              Voltar
            </Button>
            <Button
              onClick={async () => {
                setConfirmCancel(false);
                await runControl('cancel');
              }}
              disabled={controlBusy}
              className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              <Ban className="h-4 w-4" />
              Cancelar broadcast
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
