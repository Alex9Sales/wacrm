'use client';

// ============================================================
// AddChannelDialog — provider picker + provider-specific form.
//
// Step 1: pick a provider (Meta | WAHA | Evolution | EvoGo).
//   - Meta hands off to the full <WhatsAppConfig /> editor via
//     `onPickMeta` (its registration/PIN flow lives there).
//   - The three non-official providers show their own field set and
//     POST /api/channels { provider, name, config }.
// Returns the created channel to the parent so it can immediately open
// the QR pairing modal.
// ============================================================

import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import type { ProviderId } from '@/lib/channels/provider';
import { Button } from '@/components/ui/button';
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

import { PROVIDER_LABELS, type ChannelSummary } from './channels-tab';
import { EmbeddedSignupButton } from './embedded-signup-button';
import { ChannelProviderIcon } from './channel-provider-icon';
import type { DomainState } from './email-domain-dialog';

/** Modo de criação do canal de e-mail: apelido hospedado vs. domínio próprio. */
type EmailMode = 'hosted' | 'branded';

interface AddChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create (non-Meta). Carries the new row so
   *  the parent can open the QR modal. */
  onCreated: (created: ChannelSummary | null) => void;
  /** Meta was picked — the parent swaps to the WhatsAppConfig editor. */
  onPickMeta: () => void;
  /** E-mail com domínio próprio criado — o pai abre o modal de setup do DNS. */
  onBrandedCreated?: (payload: { channelId: string; initial: DomainState }) => void;
}

const PROVIDER_ORDER: ProviderId[] = ['meta', 'instagram', 'messenger', 'email', 'waha', 'evolution', 'evogo'];

// Domínio hospedado da Fluxia (espelha EMAIL_HOSTED_DOMAIN no servidor). Só pra
// mostrar o preview do endereço; quem monta o endereço final é o backend.
const EMAIL_HOSTED_DOMAIN = 'atendimento.salestecnologia.com.br';

const PROVIDER_BLURB: Record<ProviderId, string> = {
  meta: 'API oficial do WhatsApp. Suporta templates e mensagens interativas.',
  instagram: 'Instagram Direct (DM) via API oficial do Meta. Cole o ID da conta Instagram e o token de acesso.',
  messenger: 'Facebook Messenger (DM da Página) via API oficial do Meta. Cole o ID da Página e o token de acesso.',
  email: 'E-mail no inbox — a Fluxia hospeda pra você. Escolha um apelido e ganhe um endereço @atendimento.salestecnologia.com.br na hora, sem mexer em DNS.',
  waha: 'Provedor não oficial (WAHA), gerenciado pela Fluxia. Só dê um nome e pareie por QR Code.',
  evolution: 'Provedor não oficial (Evolution API), gerenciado pela Fluxia. Só dê um nome e pareie por QR Code.',
  evogo: 'Provedor não oficial (EvoGo), gerenciado pela Fluxia. Só dê um nome e pareie por QR Code.',
};

/** Per-provider config fields (non-Meta). `secret` masks the input. */
interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  optional?: boolean;
}

// WAHA / Evolution / EvoGo are MANAGED by Fluxia: the server URL + API key
// come from platform env and the session/instance is auto-generated. The
// operator only names the channel — so no config fields here.
const PROVIDER_FIELDS: Record<
  Exclude<ProviderId, 'meta'>,
  FieldDef[]
> = {
  // Instagram: conexão MANUAL (piloto) — o operador cola o id da conta IG + o
  // token. graph_base é opcional (use graph.instagram.com pro login do Instagram).
  instagram: [
    {
      key: 'ig_id',
      label: 'ID da conta Instagram (IGSID business)',
      placeholder: '17841400000000000',
    },
    {
      key: 'access_token',
      label: 'Token de acesso (Página/Instagram)',
      placeholder: 'EAAG…',
      secret: true,
    },
    {
      key: 'verify_token',
      label: 'Token de verificação do webhook (opcional)',
      placeholder: 'deixe em branco pra gerar automático',
      optional: true,
    },
    {
      key: 'graph_base',
      label: 'Base da API (opcional)',
      placeholder: 'https://graph.facebook.com/v21.0',
      optional: true,
    },
  ],
  // Messenger: conexão MANUAL — cola o id da Página do Facebook + o token da
  // Página. Roda em graph.facebook.com (default).
  messenger: [
    {
      key: 'page_id',
      label: 'ID da Página do Facebook',
      placeholder: '1234567890',
    },
    {
      key: 'access_token',
      label: 'Token de acesso (Página)',
      placeholder: 'EAAG…',
      secret: true,
    },
    {
      key: 'verify_token',
      label: 'Token de verificação do webhook (opcional)',
      placeholder: 'deixe em branco pra gerar automático',
      optional: true,
    },
    {
      key: 'graph_base',
      label: 'Base da API (opcional)',
      placeholder: 'https://graph.facebook.com/v21.0',
      optional: true,
    },
  ],
  // E-mail HOSPEDADO: cliente só escolhe um apelido → apelido@<domínio da
  // Fluxia>. Recebe pelo Cloudflare Worker (catch-all), responde pelo Resend
  // (domínio já verificado). Sem DNS, sem token.
  email: [
    {
      key: 'handle',
      label: 'Apelido do e-mail (o que vem antes do @)',
      placeholder: 'atendimento',
    },
    {
      key: 'from_name',
      label: 'Nome do remetente',
      placeholder: 'Atendimento',
      optional: true,
    },
  ],
  waha: [],
  evolution: [],
  evogo: [],
};

// E-mail com DOMÍNIO PRÓPRIO (white-label): o cliente envia com a marca dele.
const EMAIL_BRANDED_FIELDS: FieldDef[] = [
  {
    key: 'address',
    label: 'Seu e-mail (no seu domínio)',
    placeholder: 'atendimento@suaempresa.com.br',
  },
  {
    key: 'from_name',
    label: 'Nome do remetente',
    placeholder: 'Atendimento',
    optional: true,
  },
];

export function AddChannelDialog({
  open,
  onOpenChange,
  onCreated,
  onPickMeta,
  onBrandedCreated,
}: AddChannelDialogProps) {
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [emailMode, setEmailMode] = useState<EmailMode>('hosted');

  const fields = useMemo(() => {
    if (!provider || provider === 'meta') return [];
    if (provider === 'email') {
      return emailMode === 'branded' ? EMAIL_BRANDED_FIELDS : PROVIDER_FIELDS.email;
    }
    return PROVIDER_FIELDS[provider as Exclude<ProviderId, 'meta'>];
  }, [provider, emailMode]);

  // Preview do endereço hospedado (só e-mail): sanitiza o que o cliente digita.
  const emailHandle = (config.handle ?? '')
    .split('@')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '');

  const reset = useCallback(() => {
    setProvider(null);
    setName('');
    setConfig({});
    setSubmitting(false);
    setEmailMode('hosted');
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset],
  );

  const handlePickProvider = useCallback((p: ProviderId) => {
    // Meta now shows a choice (Embedded Signup vs manual editor) instead of
    // jumping straight to the manual form.
    setProvider(p);
    setConfig({});
  }, []);

  const handleCreate = useCallback(async () => {
    if (!provider || provider === 'meta') return;
    if (!name.trim()) {
      toast.error('Dê um nome ao canal.');
      return;
    }
    // All non-optional fields are required.
    for (const f of fields) {
      if (!f.optional && !config[f.key]?.trim()) {
        toast.error(`Preencha o campo "${f.label}".`);
        return;
      }
    }

    setSubmitting(true);
    try {
      // E-MAIL com DOMÍNIO PRÓPRIO: fluxo separado — cria o domínio no Resend
      // e o pai abre o modal de setup do DNS (não é o create genérico).
      if (provider === 'email' && emailMode === 'branded') {
        const res = await fetch('/api/channels/email-domain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            address: (config.address ?? '').trim(),
            from_name: (config.from_name ?? '').trim() || undefined,
          }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          toast.error(payload.error || 'Falha ao criar o canal.');
          return;
        }
        const data = (await res.json()) as {
          channelId: string;
          ingestAddress: string;
          domain: { id: string; name: string; status: string; records: DomainState['records'] };
          dnsProvider: DomainState['dnsProvider'];
        };
        toast.success('Canal criado! Agora configure o DNS para verificar o domínio.');
        onBrandedCreated?.({
          channelId: data.channelId,
          initial: {
            status: data.domain.status,
            verified: data.domain.status === 'verified',
            records: data.domain.records,
            ingestAddress: data.ingestAddress,
            address: (config.address ?? '').trim().toLowerCase(),
            domainName: data.domain.name,
            dnsProvider: data.dnsProvider ?? null,
          },
        });
        reset();
        return;
      }

      const cleanConfig: Record<string, string> = {};
      for (const f of fields) {
        const v = config[f.key]?.trim();
        if (v) cleanConfig[f.key] = v;
      }

      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, name: name.trim(), config: cleanConfig }),
      });

      if (res.status === 409) {
        toast.error('Já existe um canal com esse nome. Escolha outro.');
        return;
      }
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Falha ao criar o canal.');
        return;
      }

      const { id } = (await res.json()) as { id: string };
      if (provider === 'email') {
        const h = (config.handle ?? '').split('@')[0].trim().toLowerCase();
        toast.success(`Canal de e-mail criado: ${h}@${EMAIL_HOSTED_DOMAIN}`);
      } else if (provider === 'instagram' || provider === 'messenger') {
        toast.success('Canal criado com sucesso.');
      } else {
        toast.success('Canal criado. Escaneie o QR Code para parear.');
      }
      // Build a lightweight summary so the parent can open the QR modal
      // without waiting for a list refetch.
      onCreated({
        id,
        provider,
        name: name.trim(),
        status: 'disconnected',
        phone_number: null,
        provider_meta: {},
        created_at: new Date().toISOString(),
      });
      reset();
    } catch (err) {
      console.error('[channels] create failed:', err);
      toast.error('Não foi possível criar o canal.');
    } finally {
      setSubmitting(false);
    }
  }, [provider, name, fields, config, emailMode, onCreated, onBrandedCreated, reset]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Adicionar canal
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {!provider
              ? 'Escolha o provedor do canal de WhatsApp.'
              : provider === 'meta'
                ? 'Conecte o WhatsApp oficial em 1 clique, ou configure manualmente.'
                : fields.length === 0
                  ? `Conexão ${PROVIDER_LABELS[provider]} gerenciada pela Fluxia — só dê um nome e clique em Criar canal.`
                  : `Configure as credenciais do ${PROVIDER_LABELS[provider]}.`}
          </DialogDescription>
        </DialogHeader>

        {provider === 'meta' ? (
          <div className="space-y-3 py-2">
            {/* Embedded Signup — one-click; hides itself until env is wired. */}
            <EmbeddedSignupButton
              onConnected={() => {
                // Close + refresh the list (same path as a non-Meta create).
                onCreated(null);
                reset();
              }}
            />
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              ou
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onPickMeta();
              }}
              className="w-full border-border text-muted-foreground hover:bg-muted"
            >
              Configurar manualmente
            </Button>
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              No modo automático o cliente entra com o Facebook dele, conecta o
              número e cadastra o próprio pagamento — sem criar app na Meta.
            </p>
          </div>
        ) : !provider ? (
          <div className="grid gap-2 py-2">
            {PROVIDER_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => handlePickProvider(p)}
                className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted"
              >
                <ChannelProviderIcon provider={p} className="h-9 w-9" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">
                    {PROVIDER_LABELS[p]}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {PROVIDER_BLURB[p]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Nome do canal</Label>
              <Input
                placeholder="ex.: Atendimento comercial"
                value={name}
                onChange={(e) => setName(e.target.value)}
                // Desliga o autofill do navegador/gerenciador de senha — o
                // Chrome estava injetando lixo ("Gemini") nesses campos.
                name="fluxia-channel-title"
                autoComplete="off"
                data-1p-ignore=""
                data-lpignore="true"
                data-form-type="other"
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
            {provider === 'email' && (
              <div className="space-y-1.5">
                <Label className="text-muted-foreground">Tipo de endereço</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEmailMode('hosted');
                      setConfig({});
                    }}
                    className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                      emailMode === 'hosted'
                        ? 'border-primary/60 bg-primary/10'
                        : 'border-border bg-muted/40 hover:bg-muted'
                    }`}
                  >
                    <span className="block font-medium text-foreground">Apelido Fluxia</span>
                    <span className="text-muted-foreground">
                      Pronto na hora, sem DNS.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEmailMode('branded');
                      setConfig({});
                    }}
                    className={`rounded-md border px-3 py-2 text-left text-xs transition ${
                      emailMode === 'branded'
                        ? 'border-primary/60 bg-primary/10'
                        : 'border-border bg-muted/40 hover:bg-muted'
                    }`}
                  >
                    <span className="block font-medium text-foreground">Meu domínio</span>
                    <span className="text-muted-foreground">
                      Sua marca. Exige DNS + encaminhamento.
                    </span>
                  </button>
                </div>
              </div>
            )}
            {provider === 'instagram' && (
              <div className="space-y-1.5">
                <a
                  href="/api/instagram/oauth/start"
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-purple-500 to-pink-500 px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
                >
                  Conectar com Instagram (1 clique)
                </a>
                <p className="text-center text-[11px] text-muted-foreground">
                  Recomendado — você autoriza pelo Instagram e o canal é criado
                  sozinho. Ou preencha os dados manualmente abaixo.
                </p>
              </div>
            )}
            {provider === 'messenger' && (
              <div className="space-y-1.5">
                <a
                  href="/api/messenger/oauth/start"
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-gradient-to-r from-[#00C6FF] to-[#0068FF] px-3 py-2 text-sm font-medium text-white transition hover:opacity-90"
                >
                  Conectar com Messenger (1 clique)
                </a>
                <p className="text-center text-[11px] text-muted-foreground">
                  Recomendado — você autoriza pelo Facebook, escolhe as Páginas e
                  o canal é criado (e o webhook inscrito) sozinho. Ou preencha os
                  dados manualmente abaixo.
                </p>
              </div>
            )}
            {fields.length === 0 && (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                A URL e a chave do servidor são preenchidas automaticamente pela
                Fluxia. Depois de criar, clique em <strong>Parear</strong> para
                ler o QR Code no seu WhatsApp.
              </p>
            )}
            {fields.map((f) => (
              <div key={f.key} className="space-y-2">
                <Label className="text-muted-foreground">
                  {f.label}
                  {f.optional && (
                    <span className="ml-1 text-xs">(opcional)</span>
                  )}
                </Label>
                <Input
                  type={f.secret ? 'password' : 'text'}
                  placeholder={f.placeholder}
                  value={config[f.key] ?? ''}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                  // Desliga o autofill do navegador/gerenciador de senha — o
                  // Chrome injetava "Gemini"/senha salva nesses campos. Em
                  // campo secreto, `new-password` é o que o Chrome respeita.
                  name={`fluxia-${f.key}`}
                  autoComplete={f.secret ? 'new-password' : 'off'}
                  data-1p-ignore=""
                  data-lpignore="true"
                  data-form-type="other"
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
              </div>
            ))}
            {provider === 'email' && emailMode === 'hosted' && (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Seu e-mail:{' '}
                <strong className="break-all text-foreground">
                  {emailHandle || 'apelido'}@{EMAIL_HOSTED_DOMAIN}
                </strong>
                <br />
                Dê esse endereço aos seus clientes — as mensagens caem aqui no
                inbox e você responde por aqui mesmo. Sem DNS, sem configuração.
              </div>
            )}
            {provider === 'email' && emailMode === 'branded' && (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Depois de criar, você adiciona uns registros no DNS do seu
                domínio e configura um encaminhamento — te guiamos na tela
                seguinte. Assim o e-mail sai com a <strong>sua marca</strong>.
              </div>
            )}
          </div>
        )}

        <DialogFooter className="border-border bg-popover">
          {!provider ? (
            <Button
              variant="outline"
              onClick={() => handleClose(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
          ) : provider === 'meta' ? (
            <Button
              variant="outline"
              onClick={() => setProvider(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Voltar
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => setProvider(null)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                Voltar
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar canal'
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
