'use client';

// ============================================================
// 💬 "Cobrar pelo WhatsApp" — cobrança de UM devedor à mão, pela carteira.
//
// 22/09 (João/GoLink): "quero cobrar esse cliente agora, pelo meu número".
// O diálogo abre NA HORA com o texto da régua (mesmos números e opções de
// Ajustar), editável; "Reescrever com IA" é uma chamada só quando a pessoa
// pede. O número padrão é o de quem clica; número de outra pessoa exige
// confirmação (mesma trava do disparo). Devedor pausado ou com promessa
// mostra o motivo em âmbar e exige "Enviar mesmo assim". O envio conta como
// toque da régua — o toast diz o nº do toque e abre a conversa.
//
// Regras e textos: lib/collections/manual-send-rules.ts; envio:
// lib/collections/manual-send.ts (pelas actions de /cobrancas).
// ============================================================

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2, MessageCircle, Sparkles, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { draftManualCollectWithAi, prepareManualCollect, sendManualCollect, type WalletDebtor } from '@/app/(dashboard)/cobrancas/actions';
import type { ManualCollectPrepared } from '@/lib/collections/manual-send';
import { manualCollectSuccessMessage } from '@/lib/collections/manual-send-rules';
import { isStaleActionError, reloadForStaleAction } from '@/lib/stale-action';

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function ManualCollectDialog({ debtor, onClose, onSent }: { debtor: WalletDebtor | null; onClose: () => void; onSent: () => void }) {
  if (!debtor || !debtor.contactId) return null;
  // `key` por contato: trocar de devedor zera o estado sem setState em efeito.
  return <ManualCollectDialogInner key={debtor.contactId} contactId={debtor.contactId} name={debtor.name} onClose={onClose} onSent={onSent} />;
}

function ManualCollectDialogInner({
  contactId,
  name,
  onClose,
  onSent,
}: {
  contactId: string;
  name: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const router = useRouter();
  const [prep, setPrep] = useState<ManualCollectPrepared | null>(null);
  const [loading, setLoading] = useState(true);
  // Erro de carga fica escrito — nunca vira diálogo vazio.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [channelId, setChannelId] = useState('');
  const [confirmOther, setConfirmOther] = useState(false);
  const [overrideHold, setOverrideHold] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    prepareManualCollect(contactId)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.data) {
          setLoadError(res.error ?? 'Não foi possível montar a cobrança.');
          return;
        }
        setPrep(res.data);
        setText(res.data.text);
        setChannelId(res.data.defaultChannelId ?? '');
      })
      .catch((err) => {
        if (cancelled) return;
        if (isStaleActionError(err)) {
          reloadForStaleAction();
          return;
        }
        setLoadError('Não foi possível montar a cobrança.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const chosen = prep?.channels.find((c) => c.id === channelId) ?? null;
  const otherPerson = !!chosen && !chosen.isMine && !!chosen.ownerLabel;
  const ruleChannel = prep?.ruleChannelId ? (prep.channels.find((c) => c.id === prep.ruleChannelId) ?? null) : null;
  const offRule = !!prep?.ruleChannelId && !!chosen && chosen.id !== prep.ruleChannelId;
  const holdBlocked = !!prep?.hold.blocked;
  const canSend = !!prep && !sending && !drafting && !!text.trim() && !!chosen && (!holdBlocked || overrideHold) && (!otherPerson || confirmOther);

  async function rewrite() {
    setDrafting(true);
    try {
      const res = await draftManualCollectWithAi(contactId);
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'A IA não conseguiu reescrever agora.');
        return;
      }
      setText(res.data.text);
    } catch (err) {
      if (isStaleActionError(err)) {
        reloadForStaleAction();
        return;
      }
      toast.error('A IA não conseguiu reescrever agora.');
    } finally {
      setDrafting(false);
    }
  }

  async function send() {
    setSending(true);
    try {
      const res = await sendManualCollect({ contactId, text, channelId, confirmOtherNumber: confirmOther, overrideHold });
      if (!res.ok || !res.data) {
        toast.error(res.error ?? 'Não foi possível enviar a cobrança.');
        return;
      }
      const d = res.data;
      const extra = d.sentAsTemplate ? ' · saiu como o template aprovado (API oficial fora da janela de 24 h)' : '';
      toast.success(manualCollectSuccessMessage(d.channelLabel, d.touch) + extra, {
        duration: 12_000,
        action: { label: 'Abrir conversa', onClick: () => router.push(`/inbox?c=${d.conversationId}`) },
      });
      if (!d.recorded) {
        toast.warning('A mensagem saiu, mas o registro do toque falhou — a régua pode cobrar este cliente de novo. Confira em Envios da régua.', {
          duration: 15_000,
        });
      }
      if (d.adoptedFromEcho) {
        toast.info('O número respondeu erro, mas a mensagem já estava na conversa — não foi reenviada.', { duration: 12_000 });
      }
      onClose();
      onSent();
    } catch (err) {
      if (isStaleActionError(err)) {
        reloadForStaleAction();
        return;
      }
      toast.error('Não foi possível enviar a cobrança.');
    } finally {
      setSending(false);
    }
  }

  return (
    // Enquanto envia, o diálogo não fecha (Esc / clique fora): fechar e
    // reabrir zerava o `sending` e deixava mandar a mesma cobrança duas vezes.
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !sending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!sending}>
        <DialogHeader>
          <DialogTitle>Cobrar pelo WhatsApp — {name}</DialogTitle>
          <DialogDescription>
            A mensagem sai agora, pelo número escolhido, com a sua assinatura. Conta como toque da régua: a automática não repete a cobrança logo
            em seguida e o envio aparece em &ldquo;Envios da régua&rdquo;.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Montando a cobrança…
          </div>
        )}

        {loadError && (
          <div className="rounded-md border border-red-500/40 bg-red-50 px-3 py-2 text-sm text-red-900 dark:bg-red-950/40 dark:text-red-200">
            {loadError}
          </div>
        )}

        {prep && (
          <>
            {holdBlocked && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <p className="flex items-start gap-2">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{prep.hold.reason}</span>
                </p>
                <label className="flex items-center gap-2 font-medium">
                  <input type="checkbox" checked={overrideHold} onChange={(e) => setOverrideHold(e.target.checked)} />
                  Enviar mesmo assim
                </label>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="manual-collect-text">Mensagem {prep.touchCount > 0 ? `(toque Nº ${prep.touchCount + 1})` : '(primeiro contato)'}</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={drafting || sending}
                  onClick={rewrite}
                  title="Uma chamada de IA, com os mesmos números — a IA da régua reescreve o texto ao redor deles"
                >
                  {drafting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1.5 h-3.5 w-3.5" />}
                  Reescrever com IA
                </Button>
              </div>
              <Textarea id="manual-collect-text" value={text} onChange={(e) => setText(e.target.value)} rows={9} disabled={sending} />
              <p className="text-xs text-muted-foreground">
                {prep.summary.lines.length === 1 ? '1 parcela vencida' : `${prep.summary.lines.length} parcelas vencidas`}
                {prep.summary.showValues ? ` · ${brl(prep.summary.total)}` : ''}. Valores, datas e links vêm do Asaas — revise o texto, não os números.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-collect-channel">Enviar por</Label>
              <Select
                value={channelId}
                onValueChange={(v) => {
                  setChannelId(String(v ?? ''));
                  setConfirmOther(false);
                }}
              >
                <SelectTrigger id="manual-collect-channel" className="w-full">
                  <SelectValue>{chosen?.label ?? 'Escolha o número'}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {prep.channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {otherPerson && chosen && (
                <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <p className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>Este é o {chosen.ownerLabel}: a mensagem sai pelo WhatsApp dessa pessoa e a resposta do cliente chega pra ela.</span>
                  </p>
                  <label className="flex items-center gap-2 font-medium">
                    <input type="checkbox" checked={confirmOther} onChange={(e) => setConfirmOther(e.target.checked)} />
                    Usar esse número mesmo assim
                  </label>
                </div>
              )}
              {offRule && (
                <p className="text-xs text-muted-foreground">
                  As cobranças automáticas da régua continuam saindo pelo {ruleChannel ? ruleChannel.label : 'número escolhido em Ajustar'}.
                </p>
              )}
            </div>

            <Button disabled={!canSend} onClick={send}>
              {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <MessageCircle className="mr-1.5 h-4 w-4" />}
              Enviar agora
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
