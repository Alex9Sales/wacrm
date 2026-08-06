'use client';

import { useMemo, useRef, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  parseContactCsv,
  type ParsedContactRow,
} from '@/lib/contacts/parse-contact-csv';
import { parseVCard } from '@/lib/contacts/parse-vcard';
import {
  importContacts,
  previewImportContacts,
  listTagColors,
} from '@/app/(dashboard)/contacts/actions';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Tag,
} from 'lucide-react';

const DEFAULT_TAG_COLOR = '#3b82f6';
const PREVIEW_LIMIT = 5;

function truncateFilename(name: string, max = 48): string {
  if (name.length <= max) return name;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  const base = name.slice(0, name.length - ext.length);
  const keep = max - ext.length - 1;
  return `${base.slice(0, Math.max(keep, 12))}…${ext}`;
}

function PreviewCell({
  value,
  mono,
  maxWidth = 'max-w-[9rem]',
}: {
  value: string;
  mono?: boolean;
  maxWidth?: string;
}) {
  return (
    <span
      className={cn(
        'block truncate',
        maxWidth,
        mono && 'font-mono text-[11px]'
      )}
      title={value}
    >
      {value}
    </span>
  );
}

function ImportPreviewTags({
  tagNames,
  tagColorByKey,
}: {
  tagNames: string[];
  tagColorByKey: Map<string, string>;
}) {
  if (tagNames.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <div className="flex min-w-[4.5rem] flex-wrap gap-1">
      {tagNames.map((name) => {
        const color =
          tagColorByKey.get(name.trim().toLowerCase()) ?? DEFAULT_TAG_COLOR;
        const isKnown = tagColorByKey.has(name.trim().toLowerCase());
        return (
          <span
            key={name}
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] leading-none font-medium"
            style={{
              backgroundColor: `${color}18`,
              color,
              border: `1px solid ${color}${isKnown ? '55' : '30'}`,
            }}
            title={isKnown ? name : `${name} (será criada na importação)`}
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="truncate">{name}</span>
          </span>
        );
      })}
    </div>
  );
}

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function ImportModal({
  open,
  onOpenChange,
  onImported,
}: ImportModalProps) {
  const { accountId } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedContactRow[]>([]);
  const [hasTagsColumn, setHasTagsColumn] = useState(false);
  const [hasCompanyColumn, setHasCompanyColumn] = useState(false);
  const [tagColorByKey, setTagColorByKey] = useState<Map<string, string>>(
    new Map()
  );
  const [importing, setImporting] = useState(false);
  // Dry-run counts (how many rows are new vs. already in the account) + the
  // user's choice to overwrite the duplicates instead of skipping them.
  const [dupCount, setDupCount] = useState(0);
  const [overwriteDuplicates, setOverwriteDuplicates] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    overwritten: number;
    failed: number;
    tagsAssigned: number;
  } | null>(null);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setHasTagsColumn(false);
    setHasCompanyColumn(false);
    setTagColorByKey(new Map());
    setDupCount(0);
    setOverwriteDuplicates(false);
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setFile(selected);
    setResult(null);

    const text = await selected.text();
    // vCard (.vcf) ou CSV — decide pela extensão/tipo, com fallback pro
    // conteúdo (um .vcf sempre começa com "BEGIN:VCARD").
    const isVCard =
      /\.vcf$/i.test(selected.name) ||
      selected.type === 'text/vcard' ||
      /^\s*BEGIN:VCARD/i.test(text);
    const {
      rows,
      hasTagsColumn: csvHasTags,
      hasCompanyColumn: csvHasCompany,
    } = isVCard ? parseVCard(text) : parseContactCsv(text);

    if (rows.length === 0) {
      toast.error(
        'Nenhuma linha válida encontrada. Confirme se há uma coluna de telefone (aceita "Telefone", "Celular", "WhatsApp"…).'
      );
      setParsedRows([]);
      setHasTagsColumn(false);
      setHasCompanyColumn(false);
      setTagColorByKey(new Map());
      setDupCount(0);
      setOverwriteDuplicates(false);
      return;
    }

    setParsedRows(rows);
    setHasTagsColumn(csvHasTags);
    setHasCompanyColumn(csvHasCompany);
    setDupCount(0);
    setOverwriteDuplicates(false);

    if (csvHasTags && accountId) {
      try {
        const colorMap = await listTagColors();
        setTagColorByKey(new Map(Object.entries(colorMap)));
      } catch {
        setTagColorByKey(new Map());
      }
    } else {
      setTagColorByKey(new Map());
    }

    // Dry-run against the account so we can tell the user how many rows
    // already exist (and offer to overwrite them) before they commit.
    if (accountId) {
      try {
        const { duplicateCount } = await previewImportContacts(
          rows.map((row) => ({
            phone: row.phone,
            name: row.name,
            email: row.email,
            company: row.company,
            tagNames: row.tagNames,
            codes: row.codes,
          }))
        );
        setDupCount(duplicateCount);
      } catch {
        setDupCount(0);
      }
    }
  }

  async function handleImport() {
    if (parsedRows.length === 0) return;
    if (!accountId) {
      toast.error('Seu perfil não está vinculado a uma conta.');
      return;
    }
    setImporting(true);

    try {
      // The whole import (dedupe + insert + tag resolve/assign) runs in a
      // single server action — it authorizes the caller and derives
      // account/user + tag-create permission from the session.
      const {
        imported,
        skipped,
        overwritten,
        failed,
        tagsAssigned,
        skippedTagNames,
        tagAssignmentFailed,
      } = await importContacts(
        parsedRows.map((row) => ({
          phone: row.phone,
          name: row.name,
          email: row.email,
          company: row.company,
          tagNames: row.tagNames,
          codes: row.codes,
        })),
        { overwrite: overwriteDuplicates }
      );

      if (tagAssignmentFailed) {
        toast.warning('Contatos importados, mas algumas atribuições de etiquetas falharam.');
      }

      setResult({ imported, skipped, overwritten, failed, tagsAssigned });
      if (imported > 0) {
        toast.success(
          `${imported} contato${imported !== 1 ? 's' : ''} importado${imported !== 1 ? 's' : ''}`
        );
        onImported();
      }
      if (overwritten > 0) {
        toast.success(
          `${overwritten} contato${overwritten !== 1 ? 's' : ''} sobrescrito${overwritten !== 1 ? 's' : ''}`
        );
        onImported();
      }
      if (tagsAssigned > 0) {
        toast.success(
          `${tagsAssigned} atribuição${tagsAssigned !== 1 ? 'ões' : ''} de etiqueta aplicada${tagsAssigned !== 1 ? 's' : ''}`
        );
      }
      if (skippedTagNames.length > 0) {
        const sample = skippedTagNames.slice(0, 3).join(', ');
        const more =
          skippedTagNames.length > 3
            ? ` (+${skippedTagNames.length - 3} mais)`
            : '';
        toast.info(
          `Etiquetas desconhecidas ignoradas (crie-as em Configurações primeiro): ${sample}${more}`
        );
      }
      if (skipped > 0) {
        toast.info(`${skipped} duplicata${skipped !== 1 ? 's' : ''} ignorada${skipped !== 1 ? 's' : ''}`);
      }
      if (failed > 0) {
        toast.error(
          `${failed} contato${failed !== 1 ? 's' : ''} não foi${failed !== 1 ? 'ram' : ''} importado${failed !== 1 ? 's' : ''}`
        );
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Falha na importação';
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = parsedRows.slice(0, PREVIEW_LIMIT);
  // Tags: OR — show when the CSV declares a column or preview rows carry
  // values, so an all-empty tags column still renders for validation.
  const previewHasTags =
    hasTagsColumn || preview.some((row) => row.tagNames.length > 0);
  // Company: AND — hide unless the CSV declares it and preview has data,
  // avoiding an all-dash column that wastes horizontal space.
  const previewHasCompany =
    hasCompanyColumn && preview.some((row) => row.company?.trim());

  const tagStats = useMemo(() => {
    const names = new Set<string>();
    let rowsWithTags = 0;
    for (const row of parsedRows) {
      if (row.tagNames.length === 0) continue;
      rowsWithTags++;
      for (const name of row.tagNames) names.add(name.trim().toLowerCase());
    }
    return { unique: names.size, rowsWithTags };
  }, [parsedRows]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              Importar contatos
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground">
              Envie um CSV com uma coluna obrigatória de telefone —{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                Telefone
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                Celular
              </code>{' '}
              ou{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                phone
              </code>
              . Opcionais:{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                name
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                email
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                company
              </code>
              ,{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                tags
              </code>
              {' '}e{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                codigo_cliente
              </code>{' '}
              (separadas por vírgula; use aspas em células com vários valores).{' '}
              Também aceita{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground">
                .vcf
              </code>{' '}
              (agenda exportada do celular) — nome e telefone são lidos direto.
            </DialogDescription>
          </DialogHeader>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ')
                fileInputRef.current?.click();
            }}
            className={cn(
              'group flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-5 transition-all',
              file
                ? 'border-primary/35 bg-primary/[0.04]'
                : 'hover:border-primary/40 border-border/80 bg-background/40 hover:bg-background/70'
            )}
          >
            {file ? (
              <>
                <div className="bg-primary/15 ring-primary/25 flex size-10 items-center justify-center rounded-lg ring-1">
                  <FileText className="text-primary size-5" />
                </div>
                <p
                  className="max-w-full truncate px-2 text-sm font-medium text-popover-foreground"
                  title={file.name}
                >
                  {truncateFilename(file.name)}
                </p>
                <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {parsedRows.length} linha{parsedRows.length !== 1 ? 's' : ''}{' '}
                  {parsedRows.length !== 1 ? 'prontas' : 'pronta'}
                </span>
              </>
            ) : (
              <>
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors group-hover:bg-muted">
                  <Upload className="size-5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Clique para escolher um arquivo CSV ou vCard (.vcf)
                </p>
                <p className="text-[11px] text-muted-foreground">
                  .csv ou .vcf (agenda do celular) até o limite do navegador
                </p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,.vcf,text/vcard"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {preview.length > 0 && !result && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  Prévia · primeiras {preview.length}
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tagStats.rowsWithTags > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-muted/90 px-2 py-0.5 text-[11px] text-muted-foreground">
                      <Tag className="text-primary/80 size-3" />
                      {tagStats.unique} etiqueta{tagStats.unique !== 1 ? 's' : ''} ·{' '}
                      {tagStats.rowsWithTags} contato
                      {tagStats.rowsWithTags !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Duplicados já cadastrados — informa e deixa a pessoa escolher
                  sobrescrever (senão são ignorados). Só do que estiver
                  duplicado; tratação do 9º dígito é feita no servidor. */}
              {dupCount > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <div className="space-y-2">
                      <p className="text-xs text-foreground">
                        <span className="font-semibold">
                          {dupCount} de {parsedRows.length}
                        </span>{' '}
                        já {dupCount !== 1 ? 'estão' : 'está'} cadastrado
                        {dupCount !== 1 ? 's' : ''}. Por padrão{' '}
                        {dupCount !== 1 ? 'eles são ignorados' : 'ele é ignorado'}{' '}
                        e só os novos entram.
                      </p>
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={overwriteDuplicates}
                          onChange={(e) =>
                            setOverwriteDuplicates(e.target.checked)
                          }
                          className="size-3.5 accent-amber-500"
                        />
                        Sobrescrever {dupCount !== 1 ? 'os' : 'o'} {dupCount} com os
                        dados do arquivo (mantém campos em branco)
                      </label>
                    </div>
                  </div>
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-border ring-1 ring-border/50">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-xs">
                    <thead>
                      <tr className="border-b border-border bg-background/60">
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          Telefone
                        </th>
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          Nome
                        </th>
                        <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                          Email
                        </th>
                        {previewHasCompany && (
                          <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                            Empresa
                          </th>
                        )}
                        {previewHasTags && (
                          <th className="px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
                            Etiquetas
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {preview.map((row, i) => (
                        <tr
                          key={i}
                          className="bg-popover/40 transition-colors hover:bg-muted/30"
                        >
                          <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                            <PreviewCell
                              value={row.phone}
                              mono
                              maxWidth="max-w-[7.5rem]"
                            />
                          </td>
                          <td className="px-3 py-2 text-popover-foreground">
                            <PreviewCell
                              value={row.name || '—'}
                              maxWidth="max-w-[8.5rem]"
                            />
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            <PreviewCell
                              value={row.email || '—'}
                              maxWidth="max-w-[10rem]"
                            />
                          </td>
                          {previewHasCompany && (
                            <td className="px-3 py-2 text-muted-foreground">
                              <PreviewCell
                                value={row.company || '—'}
                                maxWidth="max-w-[7rem]"
                              />
                            </td>
                          )}
                          {previewHasTags && (
                            <td className="px-3 py-2 align-top">
                              <ImportPreviewTags
                                tagNames={row.tagNames}
                                tagColorByKey={tagColorByKey}
                              />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {parsedRows.length > PREVIEW_LIMIT && (
                <p className="text-center text-[11px] text-muted-foreground">
                  + {parsedRows.length - PREVIEW_LIMIT} linha
                  {parsedRows.length - PREVIEW_LIMIT !== 1 ? 's' : ''} não exibida
                  {parsedRows.length - PREVIEW_LIMIT !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <p className="text-sm font-medium text-popover-foreground">Importação concluída</p>
              <div className="mt-3 flex flex-wrap gap-3">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.imported} importado{result.imported !== 1 ? 's' : ''}
                  </div>
                )}
                {result.overwritten > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.overwritten} sobrescrito
                    {result.overwritten !== 1 ? 's' : ''}
                  </div>
                )}
                {result.tagsAssigned > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-cyan-400">
                    <CheckCircle className="size-4 shrink-0" />
                    {result.tagsAssigned} etiqueta
                    {result.tagsAssigned !== 1 ? 's' : ''} atribuída
                    {result.tagsAssigned !== 1 ? 's' : ''}
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {result.skipped} ignorado{result.skipped !== 1 ? 's' : ''}
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-red-400">
                    <XCircle className="size-4 shrink-0" />
                    {result.failed} com falha
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? 'Fechar' : 'Cancelar'}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={parsedRows.length === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              {overwriteDuplicates && dupCount > 0
                ? `Importar e sobrescrever ${dupCount}`
                : `Importar ${parsedRows.length > 0 ? parsedRows.length : ''} contato${parsedRows.length !== 1 ? 's' : ''}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
