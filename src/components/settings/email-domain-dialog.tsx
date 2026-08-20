'use client';

// ============================================================
// EmailDomainDialog — configuração do canal de e-mail com DOMÍNIO PRÓPRIO.
// Mostra (1) os registros SPF/DKIM p/ colar no DNS, (2) o encaminhamento p/
// receber, e um botão "Verificar" que bate no Resend. Ver
// /api/channels/email-domain/[id] + email-domains.ts.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Copy, CheckCircle2, ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface DomainRecord {
  record: string;
  type: string;
  name: string;
  value: string;
  ttl: string;
  priority?: number;
  status: string;
}

export interface DnsProvider {
  id: string;
  name: string;
  panelUrl: string | null;
  nameservers?: string[];
}

export interface DomainState {
  status: string;
  verified: boolean;
  records: DomainRecord[];
  ingestAddress: string | null;
  address: string | null;
  domainName: string | null;
  dnsProvider?: DnsProvider | null;
}

/** Passo-a-passo específico por provedor de DNS (onde adicionar os registros). */
const PROVIDER_HINTS: Record<string, string> = {
  cloudflare:
    'No painel: DNS → Records → Add record. No campo Name, cole só a parte antes do domínio (ex.: send.fluxia) — o Cloudflare completa o resto. TTL: Auto.',
  registrobr:
    'No painel do domínio: aba DNS / "Editar Zona" → adicione cada registro (tipo, nome e valor exatamente como na tabela).',
  hostinger:
    'hPanel → Domínios → seu domínio → Zona DNS (Gerenciar registros DNS) → Adicionar registro.',
  godaddy:
    'Meus Produtos → DNS do domínio → Adicionar → escolha o tipo e cole nome e valor.',
  namecheap:
    'Domain List → Manage → aba Advanced DNS → Add New Record.',
  locaweb:
    'Painel Locaweb → Domínios → Zona DNS do domínio → adicionar registro.',
  uolhost:
    'Painel UOL Host → Domínios → Zona DNS → adicionar registro.',
  kinghost:
    'Painel KingHost → Domínios → Zona DNS → adicionar registro.',
  hostgator:
    'Painel HostGator → Domínios → Zona DNS (cPanel) → adicionar registro.',
  google:
    'No painel de domínios (Squarespace/Google) → DNS → Custom records → adicionar.',
  vercel:
    'Vercel → Domains → seu domínio → adicionar os registros DNS.',
  aws:
    'Route 53 → Hosted zones → seu domínio → Create record.',
};

function providerHint(id: string | undefined): string {
  return (
    (id && PROVIDER_HINTS[id]) ||
    'No painel de DNS do seu domínio, adicione os registros abaixo (tipo, nome e valor conforme a tabela).'
  );
}

interface EmailDomainDialogProps {
  channelId: string | null;
  /** Estado inicial vindo da criação (evita um fetch a mais). */
  initial?: DomainState | null;
  onClose: () => void;
  /** Chamado quando o domínio verifica (pra o pai recarregar a lista). */
  onVerified?: () => void;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          toast.error('Não consegui copiar.');
        }
      }}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Copiar"
    >
      {done ? <CheckCircle2 className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}

export function EmailDomainDialog({
  channelId,
  initial,
  onClose,
  onVerified,
}: EmailDomainDialogProps) {
  const [state, setState] = useState<DomainState | null>(initial ?? null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Busca o estado atual quando abre sem estado inicial.
  const load = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/channels/email-domain/${channelId}`);
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        toast.error(p.error || 'Falha ao carregar o domínio.');
        return;
      }
      setState((await res.json()) as DomainState);
    } catch {
      toast.error('Não foi possível carregar o domínio.');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    if (channelId && !initial) void load();
    if (initial) setState(initial);
  }, [channelId, initial, load]);

  const verify = useCallback(async () => {
    if (!channelId) return;
    setVerifying(true);
    try {
      const res = await fetch(`/api/channels/email-domain/${channelId}`, {
        method: 'POST',
      });
      const p = (await res.json().catch(() => ({}))) as DomainState & { error?: string };
      if (!res.ok) {
        toast.error(p.error || 'Falha ao verificar.');
        return;
      }
      setState(p);
      if (p.verified) {
        toast.success('Domínio verificado! Agora você envia com a sua marca. 🎉');
        onVerified?.();
      } else {
        toast.message('Ainda não verificou — o DNS pode levar alguns minutos.');
      }
    } catch {
      toast.error('Não foi possível verificar.');
    } finally {
      setVerifying(false);
    }
  }, [channelId, onVerified]);

  const open = channelId !== null;
  const verified = state?.verified ?? false;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Conectar meu domínio {state?.domainName ? `— ${state.domainName}` : ''}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Envie e receba com a sua marca ({state?.address ?? 'seu e-mail'}). Dois
            passos: DNS pra enviar + encaminhamento pra receber.
          </DialogDescription>
        </DialogHeader>

        {verified ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-4" />
            Domínio verificado. Você já envia com a sua marca — confirme o
            encaminhamento abaixo pra também receber.
          </div>
        ) : (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Aguardando verificação. O DNS pode levar de minutos a algumas horas
            pra propagar.
          </div>
        )}

        {loading && !state ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="space-y-5 py-1">
            {/* Passo 1 — DNS de envio */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">
                1. Adicione no DNS do seu domínio (para enviar)
              </h3>
              {state?.dnsProvider && (
                <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Seu DNS parece estar no</span>
                    <span className="font-medium text-foreground">{state.dnsProvider.name}</span>
                    {state.dnsProvider.panelUrl && (
                      <a
                        href={state.dnsProvider.panelUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        abrir painel <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {providerHint(state.dnsProvider.id)}
                  </p>
                </div>
              )}
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Tipo</th>
                      <th className="px-2 py-1.5 font-medium">Nome</th>
                      <th className="px-2 py-1.5 font-medium">Valor</th>
                      <th className="px-2 py-1.5 font-medium">TTL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(state?.records ?? []).map((r, i) => (
                      <tr key={i} className="border-t border-border align-top">
                        <td className="px-2 py-1.5 font-mono text-foreground">
                          {r.type}
                          {typeof r.priority === 'number' ? ` (${r.priority})` : ''}
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-start gap-1">
                            <span className="break-all font-mono text-foreground">{r.name}</span>
                            <CopyButton text={r.name} />
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-start gap-1">
                            <span className="break-all font-mono text-muted-foreground">
                              {r.value}
                            </span>
                            <CopyButton text={r.value} />
                          </div>
                        </td>
                        <td className="px-2 py-1.5 font-mono text-muted-foreground">{r.ttl}</td>
                      </tr>
                    ))}
                    {(state?.records ?? []).length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-2 py-3 text-center text-muted-foreground">
                          Sem registros — clique em Verificar pra recarregar.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Passo 2 — encaminhamento pra receber */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">
                2. Configure o encaminhamento (para receber)
              </h3>
              <p className="text-xs text-muted-foreground">
                No seu provedor de e-mail, crie um encaminhamento (forward) de{' '}
                <strong className="text-foreground">{state?.address ?? 'seu e-mail'}</strong> para o
                endereço abaixo. As respostas dos clientes caem aqui no inbox.
              </p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                <code className="flex-1 break-all text-xs text-foreground">
                  {state?.ingestAddress ?? '—'}
                </code>
                {state?.ingestAddress && <CopyButton text={state.ingestAddress} />}
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={onClose}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Fechar
          </Button>
          <Button
            onClick={verify}
            disabled={verifying}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {verifying ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Verificando...
              </>
            ) : verified ? (
              'Verificar de novo'
            ) : (
              'Verificar domínio'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
