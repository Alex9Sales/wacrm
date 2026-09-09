'use client';

// ============================================================
// 📒 Importar agenda do celular pra um canal (Canais → "Agenda").
// Abre já com a PRÉVIA (puxa a agenda no WAHA e simula os dois modos), deixa
// escolher o modo + se cria quem ainda não existe, e mostra o resultado.
// Regra fixa: nome digitado no CRM nunca é trocado. Depois do 1º import o
// número entra na sincronização de 6 em 6 h (worker phonebook-sync).
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BookUser, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { NameMode } from '@/lib/contacts/name-rule';
import type { PhonebookApplySummary } from '@/lib/contacts/phonebook';

import type { ChannelSummary } from './channels-tab';
import {
  applyPhonebookImport,
  previewPhonebookImport,
  type PhonebookPreview,
} from './phonebook-actions';

function fmtTime(iso: string | null): string {
  if (!iso) return 'nunca';
  try {
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function n(v: number, singular: string, plural: string): string {
  return `${v} ${v === 1 ? singular : plural}`;
}

export function ChannelPhonebookDialog({
  channel,
  onClose,
  onImported,
}: {
  channel: ChannelSummary;
  onClose: () => void;
  onImported?: () => void;
}) {
  const [preview, setPreview] = useState<PhonebookPreview | null>(null);
  const [mode, setMode] = useState<NameMode>('fill');
  // Desmarcado por padrão: a agenda do Alex tem 11,8 mil nomes e só 1,2 mil
  // estão no CRM — criar 10 mil contatos (pessoais, antigos) tem que ser
  // escolha explícita, não vem de brinde com "corrigir nomes".
  const [createMissing, setCreateMissing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<PhonebookApplySummary | null>(null);

  useEffect(() => {
    let alive = true;
    previewPhonebookImport(channel.id)
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch(() => {
        if (alive) setPreview({ ok: false, error: 'Não foi possível ler a agenda. Recarregue a página (F5) e tente de novo.' });
      });
    return () => {
      alive = false;
    };
  }, [channel.id]);

  const sim = preview?.ok ? (mode === 'override' ? preview.override : preview.fill) : null;
  const willChange = sim ? sim.filled + sim.upgraded + sim.mirrored + sim.overridden : 0;
  const willCreate = sim && createMissing ? sim.notInCrm : 0;
  const nothingToDo = !!sim && willChange === 0 && willCreate === 0;

  const apply = async () => {
    if (!preview?.ok || applying) return;
    setApplying(true);
    try {
      const r = await applyPhonebookImport(channel.id, { mode, createMissing });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setResult(r.summary);
      toast.success('Agenda importada');
      onImported?.();
    } catch {
      toast.error('Não consegui importar a agenda. Recarregue a página (F5) e tente de novo.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookUser className="size-4" />
            Agenda do celular · {channel.name}
          </DialogTitle>
          <DialogDescription>
            Traz para o CRM os contatos salvos no aparelho, com o nome do jeito que
            você salvou. Nome que alguém digitou aqui no CRM nunca é trocado.
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Lendo a agenda do celular…
          </p>
        ) : !preview.ok ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {preview.error}
          </p>
        ) : result ? (
          <div className="space-y-2 rounded-lg border border-border bg-background p-3 text-sm">
            <p className="font-medium text-foreground">Pronto.</p>
            <ul className="space-y-1 text-muted-foreground">
              {result.created > 0 && <li>{n(result.created, 'contato criado', 'contatos criados')} no CRM.</li>}
              {result.filled > 0 && <li>{n(result.filled, 'contato que estava sem nome', 'contatos que estavam sem nome')} ganhou o nome da agenda.</li>}
              {result.upgraded > 0 && <li>{n(result.upgraded, 'nome de perfil do WhatsApp trocado', 'nomes de perfil do WhatsApp trocados')} pelo nome da agenda.</li>}
              {result.mirrored > 0 && <li>{n(result.mirrored, 'nome acompanhou', 'nomes acompanharam')} uma mudança na agenda.</li>}
              {result.overridden > 0 && <li>{n(result.overridden, 'nome antigo trocado', 'nomes antigos trocados')} pelo da agenda.</li>}
              {result.keptCrm > 0 && <li>{n(result.keptCrm, 'nome editado no CRM mantido', 'nomes editados no CRM mantidos')}.</li>}
              {result.unchanged > 0 && <li>{n(result.unchanged, 'contato já estava igual', 'contatos já estavam iguais')}.</li>}
              {result.created + result.filled + result.upgraded + result.mirrored + result.overridden === 0 && (
                <li>Nenhum nome precisou mudar.</li>
              )}
            </ul>
            <p className="pt-1 text-xs text-muted-foreground">
              A partir de agora a agenda deste número é conferida a cada 6 horas: quem
              estiver sem nome ganha o da agenda, e mudanças na agenda são acompanhadas.
            </p>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-border bg-background p-3">
              {preview.entries === 0 ? (
                preview.kind === 'push' ? (
                  <p className="text-muted-foreground">
                    Ainda não recebemos a agenda deste número. Na API oficial em
                    coexistência a Meta envia os contatos do aparelho pelo webhook
                    <code className="mx-1 rounded bg-muted px-1">smb_app_state_sync</code>
                    — esse campo precisa estar assinado no app da Meta. Assim que
                    chegar, os nomes entram sozinhos.
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    Nenhum contato com nome salvo na agenda deste aparelho.
                  </p>
                )
              ) : (
                <p className="text-foreground">
                  <span className="font-medium">{n(preview.entries, 'contato salvo', 'contatos salvos')}</span> na
                  agenda · {n(preview.fill.matched, 'já está', 'já estão')} no CRM ·{' '}
                  {n(preview.fill.notInCrm, 'ainda não existe', 'ainda não existem')}.
                  <span className="block text-xs text-muted-foreground">
                    Última leitura: {fmtTime(preview.syncedAt)}
                  </span>
                </p>
              )}
            </div>

            {preview.entries > 0 && (
              <>
                <fieldset className="space-y-2">
                  <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Como tratar quem já tem nome no CRM
                  </legend>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/40">
                    <input
                      type="radio"
                      name="phonebook-mode"
                      className="mt-0.5"
                      checked={mode === 'fill'}
                      onChange={() => setMode('fill')}
                    />
                    <span>
                      <span className="font-medium text-foreground">Só preencher e corrigir perfil</span>
                      <span className="block text-xs text-muted-foreground">
                        Dá nome a quem está sem nome, troca o nome de perfil do WhatsApp
                        pelo da agenda e deixa o resto como está. Recomendado.
                      </span>
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2.5 hover:bg-muted/40">
                    <input
                      type="radio"
                      name="phonebook-mode"
                      className="mt-0.5"
                      checked={mode === 'override'}
                      onChange={() => setMode('override')}
                    />
                    <span>
                      <span className="font-medium text-foreground">Agenda do celular manda</span>
                      <span className="block text-xs text-muted-foreground">
                        Troca também os nomes antigos pelo da agenda. Só nomes editados
                        aqui no CRM (a partir de hoje) ficam como estão.
                      </span>
                    </span>
                  </label>
                </fieldset>

                {preview.fill.notInCrm > 0 && (
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={createMissing}
                      onChange={(e) => setCreateMissing(e.target.checked)}
                    />
                    <span className="text-foreground">
                      Criar no CRM os {preview.fill.notInCrm} contatos que ainda não existem
                    </span>
                  </label>
                )}

                {sim && (
                  <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                    <p className="mb-1 font-medium text-foreground">O que vai acontecer</p>
                    <ul className="space-y-0.5">
                      {willCreate > 0 && <li>{n(willCreate, 'contato criado', 'contatos criados')}.</li>}
                      {sim.filled > 0 && <li>{n(sim.filled, 'contato sem nome recebe', 'contatos sem nome recebem')} o nome da agenda.</li>}
                      {sim.upgraded > 0 && <li>{n(sim.upgraded, 'nome de perfil do WhatsApp vira', 'nomes de perfil do WhatsApp viram')} o da agenda.</li>}
                      {sim.mirrored > 0 && <li>{n(sim.mirrored, 'nome acompanha', 'nomes acompanham')} a agenda.</li>}
                      {sim.overridden > 0 && <li>{n(sim.overridden, 'nome antigo é trocado', 'nomes antigos são trocados')}.</li>}
                      {sim.keptCrm > 0 && <li>{n(sim.keptCrm, 'nome editado no CRM fica', 'nomes editados no CRM ficam')} como está.</li>}
                      {mode === 'fill' && sim.keptLegacy > 0 && (
                        <li>{n(sim.keptLegacy, 'nome antigo fica', 'nomes antigos ficam')} como está (escolha “Agenda do celular manda” para trocar).</li>
                      )}
                      {sim.unchanged > 0 && <li>{n(sim.unchanged, 'contato já está', 'contatos já estão')} igual à agenda.</li>}
                      {nothingToDo && <li>Nada a mudar — tudo já está igual à agenda.</li>}
                    </ul>
                    {sim.examples.length > 0 && (
                      <p className="mt-2">
                        Exemplos:{' '}
                        {sim.examples.map((e, i) => (
                          <span key={i}>
                            {i > 0 ? ' · ' : ''}
                            <span className="line-through">{e.from || '(sem nome)'}</span> → {e.to}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="border-border">
            {result ? 'Fechar' : 'Cancelar'}
          </Button>
          {preview?.ok && !result && preview.entries > 0 && (
            <Button onClick={apply} disabled={applying || nothingToDo}>
              {applying ? <Loader2 className="size-4 animate-spin" /> : <BookUser className="size-4" />}
              Importar agenda
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
