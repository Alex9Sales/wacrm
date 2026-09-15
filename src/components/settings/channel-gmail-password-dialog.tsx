'use client';

// ============================================================
// Trocar a senha de app de um canal Gmail — sem apagar o canal.
//
// 15/09 (GoLink): o Google revogou a senha de app e a única saída era apagar e
// recriar o canal (perdendo conversas e o ponto de leitura). Aqui o admin cola
// a senha nova; o servidor testa no Google (envio + leitura) e só grava se o
// Google aceitar. POST /api/channels/:id/gmail-password.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

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
import { gmailHealthOf, gmailProblem } from '@/lib/channels/gmail-health-state';

import type { ChannelSummary } from './channels-tab';
import { GmailAppPasswordHelp } from './gmail-app-password-help';

const FORMAT_ERROR =
  'A senha de app do Google tem 16 letras (ex.: abcd efgh ijkl mnop). Não é a senha normal da conta.';

interface ReplaceResponse {
  ok?: boolean;
  error?: string;
  pollResumesNow?: boolean;
  mailboxMatches?: boolean | null;
  backlogEstimate?: number | null;
}

function fmtSince(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function ChannelGmailPasswordDialog({
  channel,
  onClose,
  onSaved,
}: {
  channel: ChannelSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const address =
    (channel.provider_meta as { address?: string | null }).address ?? '';
  const problem = gmailProblem(gmailHealthOf(channel.provider_meta));
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const compact = password.replace(/\s+/g, '');
  const looksValid = /^[a-zA-Z]{16}$/.test(compact);
  const showFormatHint = compact.length >= 16 && !looksValid;

  const save = async () => {
    if (!looksValid) {
      toast.error(FORMAT_ERROR);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}/gmail-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_password: compact }),
      });
      const d = (await res.json().catch(() => ({}))) as ReplaceResponse;
      if (!res.ok || !d.ok) {
        toast.error(d.error || 'Não foi possível trocar a senha de app.');
        return;
      }

      const when =
        d.pollResumesNow === false ? 'em até 30 minutos' : 'em até 1 minuto';
      let msg = `Senha de app atualizada. O Gmail volta a ler a caixa ${when}.`;
      const backlog = d.backlogEstimate ?? 0;
      if (backlog > 0) {
        const quando =
          d.pollResumesNow === false ? 'quando a leitura voltar' : 'agora';
        msg +=
          backlog === 1
            ? ` Cerca de 1 e-mail que chegou enquanto estava parado vai entrar ${quando}.`
            : ` Cerca de ${backlog} e-mails que chegaram enquanto estava parado vão entrar ${quando}.`;
      }
      toast.success(msg, { duration: 8000 });
      if (d.mailboxMatches === false) {
        toast.warning(
          'A caixa do Gmail respondeu diferente da última leitura. Os e-mails novos entram normalmente, mas os que chegaram enquanto estava parado podem não ser importados.',
          { duration: 12000 }
        );
      }
      setPassword('');
      onSaved();
    } catch (err) {
      console.error('[channels] troca de senha de app falhou:', err);
      toast.error('Não foi possível trocar a senha de app.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Trocar senha de app</DialogTitle>
          <DialogDescription>
            As conversas e os e-mails já recebidos continuam. Antes de salvar, a
            gente testa a senha no Google.
          </DialogDescription>
        </DialogHeader>

        {/* `contents`: os filhos viram itens do grid do diálogo (o rodapé
            encosta na borda como nos outros diálogos) e o Enter envia. */}
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving) void save();
          }}
          autoComplete="off"
        >
          <div className="flex flex-col gap-3 py-2">
            {problem && (
              <p className="rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-xs text-red-600 dark:text-red-400">
                {problem.message}
                {problem.since ? ` Desde ${fmtSince(problem.since)}.` : ''}
              </p>
            )}

            <div className="space-y-1.5">
              <Label className="text-muted-foreground">Gmail do canal</Label>
              <Input
                value={address || '—'}
                readOnly
                disabled
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="fluxia-gmail-new-app-password"
                className="text-muted-foreground"
              >
                Nova senha de app do Google (16 letras)
              </Label>
              <Input
                id="fluxia-gmail-new-app-password"
                type="password"
                name="fluxia-gmail-app-password"
                placeholder="xxxx xxxx xxxx xxxx"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                // Sem autofill: o Chrome/gerenciador injetava a senha salva da
                // conta aqui (e a senha normal não serve).
                autoComplete="new-password"
                data-1p-ignore=""
                data-lpignore="true"
                data-form-type="other"
                aria-invalid={showFormatHint || undefined}
                disabled={saving}
                autoFocus
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
              {showFormatHint && (
                <p className="text-[11px] text-red-500">{FORMAT_ERROR}</p>
              )}
            </div>

            <GmailAppPasswordHelp showDedicatedTip={false} />
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={saving}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || compact.length === 0}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {saving ? 'Testando no Google...' : 'Salvar senha'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
