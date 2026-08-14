'use client';

// ============================================================
// IntegrationsSettings — Settings → "Integrações"
//
// Manage outbound webhooks: the account pastes a webhook URL (n8n,
// Make, or any HTTPS endpoint) and picks which CRM events to receive.
// The backend (webhook_endpoints + dispatchWebhookEvent) already
// delivers the events; this UI + /api/integrations/webhooks let the
// user manage endpoints by clicking, with no API key.
//
// Any member sees the roster (read-only); admin+ can create, toggle,
// and delete (gated by <RequireRole min="admin"> here and the
// admin-only session API routes on the server).
//
// One-time reveal: on creation the signing secret (whsec_…) is shown
// ONCE with a copy button. It signs deliveries (X-Wacrm-Signature) and
// is never resurfaced — the server keeps only an encrypted copy.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Copy,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Webhook,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@/lib/webhooks/events';
import { SettingsPanelHead } from './settings-panel-head';

// pt-BR labels for the events the user can subscribe to. Keyed on the
// canonical event names from src/lib/webhooks/events.ts.
const EVENT_LABELS: Record<WebhookEvent, string> = {
  'message.received': 'Mensagem recebida',
  'conversation.created': 'Nova conversa',
  'message.status_updated': 'Status de mensagem (entregue/lido)',
};

const EVENT_HINTS: Record<WebhookEvent, string> = {
  'message.received': 'Dispara quando um contato envia uma mensagem.',
  'conversation.created': 'Dispara quando uma nova conversa é aberta.',
  'message.status_updated':
    'Dispara quando uma mensagem enviada muda de status.',
};

interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  channel_id: string | null;
  is_active: boolean;
  last_delivery_at: string | null;
  failure_count: number;
  created_at: string;
  has_secret: boolean;
}

interface ChannelOpt {
  id: string;
  name: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function IntegrationsSettings() {
  const { canEditSettings } = useAuth();

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [channels, setChannels] = useState<ChannelOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WebhookEndpoint | null>(
    null,
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/webhooks', {
        cache: 'no-store',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao carregar integrações');
        return;
      }
      const data = (await res.json()) as { webhooks: WebhookEndpoint[] };
      setEndpoints(data.webhooks);
    } catch (err) {
      console.error('[IntegrationsSettings] load error:', err);
      toast.error('Não foi possível contatar o servidor');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Canais da conta — pro seletor "Caixa de entrada" e pra rotular cada webhook.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/channels');
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.channels)) setChannels(data.channels);
      } catch {
        /* best-effort */
      }
    })();
  }, []);

  const channelName = (id: string | null) =>
    id ? (channels.find((c) => c.id === id)?.name ?? 'Canal') : 'Todos os canais';

  async function handleToggle(endpoint: WebhookEndpoint, next: boolean) {
    setBusyId(endpoint.id);
    try {
      const res = await fetch(`/api/integrations/webhooks/${endpoint.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao atualizar');
        return;
      }
      const data = (await res.json()) as { webhook: WebhookEndpoint };
      setEndpoints((prev) =>
        prev.map((e) => (e.id === endpoint.id ? data.webhook : e)),
      );
      toast.success(next ? 'Integração ativada' : 'Integração pausada');
    } catch (err) {
      console.error('[IntegrationsSettings] toggle error:', err);
      toast.error('Não foi possível contatar o servidor');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(endpoint: WebhookEndpoint) {
    setBusyId(endpoint.id);
    try {
      const res = await fetch(`/api/integrations/webhooks/${endpoint.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao remover');
        return;
      }
      setEndpoints((prev) => prev.filter((e) => e.id !== endpoint.id));
      toast.success('Integração removida');
    } catch (err) {
      console.error('[IntegrationsSettings] delete error:', err);
      toast.error('Não foi possível contatar o servidor');
    } finally {
      setBusyId(null);
      setConfirmDelete(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Integrações"
        description="Receba eventos do CRM em tempo real no n8n, Make, ou qualquer webhook. Cole a URL do seu fluxo e escolha os eventos."
        action={
          <RequireRole min="admin">
            <Button
              onClick={() => {
                setEditing(null);
                setCreateOpen(true);
              }}
            >
              <Plus className="size-4" />
              Nova integração
            </Button>
          </RequireRole>
        }
      />

      {/* How-to hint */}
      <Card className="border-border bg-muted/30">
        <CardContent className="space-y-1.5 py-4 text-sm">
          <p className="text-foreground font-medium">Como usar no n8n</p>
          <ol className="text-muted-foreground list-inside list-decimal space-y-0.5 text-xs">
            <li>
              No n8n, crie um nó <span className="text-foreground">Webhook</span>{' '}
              e copie a URL de produção dele.
            </li>
            <li>Cole essa URL aqui e escolha os eventos que quer receber.</li>
            <li>
              Guarde o segredo exibido na criação — ele assina cada entrega no
              header <code className="text-[11px]">X-Wacrm-Signature</code>.
            </li>
          </ol>
        </CardContent>
      </Card>

      {endpoints.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">
              Nenhuma integração ainda.
            </p>
            {canEditSettings ? (
              <p className="text-muted-foreground mt-1 text-xs">
                Clique em{' '}
                <span className="text-foreground">Nova integração</span> para
                adicionar um webhook.
              </p>
            ) : (
              <p className="text-muted-foreground mt-1 text-xs">
                Peça a um admin para adicionar uma.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {endpoints.map((e) => {
                const disabledByFailures = !e.is_active && e.failure_count > 0;
                return (
                  <li
                    key={e.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <p
                        className={`truncate font-mono text-sm ${
                          e.is_active
                            ? 'text-foreground'
                            : 'text-muted-foreground'
                        }`}
                        title={e.url}
                      >
                        {e.url}
                      </p>

                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {e.events.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            Nenhum evento
                          </span>
                        ) : (
                          e.events.map((ev) => (
                            <Badge
                              key={ev}
                              className="border-border bg-muted text-muted-foreground text-[10px]"
                            >
                              {EVENT_LABELS[ev as WebhookEvent] ?? ev}
                            </Badge>
                          ))
                        )}
                      </div>

                      <p className="text-muted-foreground mt-1.5 text-xs">
                        <span className="font-medium text-foreground">
                          {channelName(e.channel_id)}
                        </span>
                        {' · Criada '}
                        {fmtDate(e.created_at)}
                        {' · '}
                        {e.last_delivery_at
                          ? `última entrega ${fmtDate(e.last_delivery_at)}`
                          : 'nenhuma entrega ainda'}
                        {' · '}
                        <span className="text-muted-foreground/80">
                          segredo configurado
                        </span>
                      </p>

                      {disabledByFailures && (
                        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-400">
                          <AlertTriangle className="size-3.5" />
                          Pausada após {e.failure_count} falhas de entrega.
                          Reative para tentar de novo.
                        </p>
                      )}
                    </div>

                    <RequireRole min="admin">
                      <div className="flex items-center gap-3 self-start sm:self-auto">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch
                            checked={e.is_active}
                            disabled={busyId === e.id}
                            onCheckedChange={(next) => handleToggle(e, next)}
                          />
                          {e.is_active ? 'Ativa' : 'Pausada'}
                        </label>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditing(e);
                            setCreateOpen(true);
                          }}
                          disabled={busyId === e.id}
                        >
                          <Pencil className="size-4" />
                          Editar
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmDelete(e)}
                          disabled={busyId === e.id}
                          className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                        >
                          {busyId === e.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                          Remover
                        </Button>
                      </div>
                    </RequireRole>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateWebhookDialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) setEditing(null);
        }}
        onCreated={load}
        channels={channels}
        editing={editing}
      />

      <ConfirmDeleteDialog
        endpoint={confirmDelete}
        deleting={busyId === confirmDelete?.id}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && handleDelete(confirmDelete)}
      />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time secret reveal.
// ------------------------------------------------------------

function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
  channels,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  channels: ChannelOpt[];
  editing?: WebhookEndpoint | null;
}) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [channelId, setChannelId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Once set, we switch from the form to the reveal view.
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const isEdit = !!editing;

  // Pré-preenche ao abrir em modo edição (e limpa ao abrir em modo criação).
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setUrl(editing.url);
      setEvents(editing.events as WebhookEvent[]);
      setChannelId(editing.channel_id ?? '');
    } else {
      setUrl('');
      setEvents([]);
      setChannelId('');
    }
  }, [open, editing]);

  function reset() {
    setUrl('');
    setEvents([]);
    setChannelId('');
    setSubmitting(false);
    setCreatedSecret(null);
  }

  function toggleEvent(event: WebhookEvent, checked: boolean) {
    setEvents((prev) =>
      checked ? [...prev, event] : prev.filter((e) => e !== event),
    );
  }

  async function handleCreate() {
    const trimmed = url.trim();
    if (!trimmed) {
      toast.error('Informe a URL do webhook');
      return;
    }
    if (events.length === 0) {
      toast.error('Escolha ao menos um evento');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        isEdit
          ? `/api/integrations/webhooks/${editing!.id}`
          : '/api/integrations/webhooks',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: trimmed,
            events,
            channel_id: channelId || null,
          }),
        },
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          payload.error ||
            (isEdit ? 'Falha ao salvar integração' : 'Falha ao criar integração'),
        );
        return;
      }
      if (isEdit) {
        // Edição não gera novo segredo — fecha e recarrega.
        toast.success('Integração atualizada');
        onCreated();
        onOpenChange(false);
      } else {
        setCreatedSecret(payload.secret as string);
        onCreated();
      }
    } catch (err) {
      console.error('[CreateWebhookDialog] submit error:', err);
      toast.error('Não foi possível contatar o servidor');
    } finally {
      setSubmitting(false);
    }
  }

  async function copySecret() {
    if (!createdSecret) return;
    try {
      await navigator.clipboard.writeText(createdSecret);
      toast.success('Segredo copiado');
    } catch {
      toast.error('Falha ao copiar — selecione e copie manualmente');
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
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {createdSecret ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                Copie o segredo de assinatura
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Guarde este segredo — ele assina os webhooks (header{' '}
                <code className="text-[11px]">X-Wacrm-Signature</code>). Esta é a
                única vez que ele será exibido. Se perdê-lo, remova a integração
                e crie outra.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">Segredo</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={createdSecret}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={copySecret}>
                  <Copy className="size-4" />
                  Copiar
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Concluído
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {isEdit ? 'Editar integração' : 'Nova integração'}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Cole a URL do seu fluxo (n8n, Make, ou qualquer endpoint HTTPS),
                escolha o canal e os eventos que quer receber.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-url" className="text-muted-foreground">
                  URL do webhook
                </Label>
                <Input
                  id="webhook-url"
                  value={url}
                  type="url"
                  placeholder="https://seu-n8n.exemplo.com/webhook/..."
                  onChange={(e) => setUrl(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Deve ser uma URL <code className="text-[11px]">https://</code>.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-muted-foreground">
                  Caixa de entrada (canal)
                </Label>
                <select
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  className="border-border bg-background text-foreground h-9 w-full rounded-md border px-2 text-sm"
                >
                  <option value="">Todos os canais</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="text-muted-foreground text-xs">
                  O webhook dispara só neste canal. Deixe em{' '}
                  <strong>Todos os canais</strong> para receber de todos.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">Eventos</Label>
                <div className="border-border space-y-2 rounded-md border p-3">
                  {WEBHOOK_EVENTS.map((event) => (
                    <label
                      key={event}
                      className="flex cursor-pointer items-start gap-2.5"
                    >
                      <Checkbox
                        checked={events.includes(event)}
                        onCheckedChange={(checked) =>
                          toggleEvent(event, checked === true)
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block text-sm">
                          {EVENT_LABELS[event]}
                        </span>
                        <span className="text-muted-foreground block text-xs">
                          {EVENT_HINTS[event]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {isEdit ? 'Salvando…' : 'Criando…'}
                  </>
                ) : isEdit ? (
                  'Salvar alterações'
                ) : (
                  'Criar integração'
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Delete confirmation.
// ------------------------------------------------------------

function ConfirmDeleteDialog({
  endpoint,
  deleting,
  onCancel,
  onConfirm,
}: {
  endpoint: WebhookEndpoint | null;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={!!endpoint} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Remover integração
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Os eventos deixarão de ser enviados para esta URL. Esta ação não pode
            ser desfeita.
          </DialogDescription>
        </DialogHeader>

        {endpoint && (
          <p className="text-muted-foreground bg-muted/50 rounded-md px-3 py-2 font-mono text-xs break-all">
            {endpoint.url}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onCancel}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancelar
          </Button>
          <Button
            onClick={onConfirm}
            disabled={deleting}
            className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
          >
            {deleting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Removendo…
              </>
            ) : (
              'Remover'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
