'use client'

// Anexos do disparo pela etapa (WhatsApp e e-mail) — até 10, clique ou arraste.
// Mesmo upload e limites do formulário de Disparos (text-broadcast-form):
// no WhatsApp cada anexo vira uma mensagem (legenda no 1º); no e-mail vão
// todos num único e-mail. 15/09 (GoLink): a etapa passou a aceitar anexos.

import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { toast } from 'sonner'
import { Loader2, Paperclip, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  EMAIL_MAX_BYTES,
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
} from '@/lib/storage/upload-media'
import { STAGE_MAX_ATTACHMENTS } from '@/lib/broadcasts/stage-broadcast'

export type StageMediaKind = 'image' | 'video' | 'document' | 'audio'

export interface StageMediaItem {
  url: string
  type: StageMediaKind
  filename: string
}

export function kindFromMime(type: string): StageMediaKind {
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return 'document'
}

const KIND_LABEL: Record<StageMediaKind, string> = {
  image: 'imagem',
  video: 'vídeo',
  audio: 'áudio',
  document: 'documento',
}

export function StageBroadcastAttachments({
  items,
  setItems,
  uploading,
  setUploading,
  isEmail,
  hasText,
}: {
  items: StageMediaItem[]
  setItems: Dispatch<SetStateAction<StageMediaItem[]>>
  uploading: boolean
  setUploading: (v: boolean) => void
  isEmail: boolean
  hasText: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  async function addFiles(files: File[]) {
    if (files.length === 0) return
    setUploading(true)
    let added = 0
    try {
      for (const file of files) {
        if (items.length + added >= STAGE_MAX_ATTACHMENTS) {
          toast.error(`Máximo de ${STAGE_MAX_ATTACHMENTS} anexos por disparo.`)
          break
        }
        const kind = kindFromMime(file.type)
        const max = isEmail ? EMAIL_MAX_BYTES : MEDIA_MAX_BYTES_BY_KIND[kind]
        if (file.size > max) {
          toast.error(`"${file.name}" é grande demais (máx. ${Math.round(max / 1024 / 1024)}MB).`)
          continue
        }
        const { publicUrl } = await uploadAccountMedia('media', file)
        setItems((prev) => [...prev, { url: publicUrl, type: kind, filename: file.name }])
        added++
      }
      if (added > 0) toast.success(added === 1 ? 'Anexo adicionado.' : `${added} anexos adicionados.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao enviar o arquivo.')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="space-y-1.5">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt"
        className="hidden"
        onChange={(e) => void addFiles(Array.from(e.target.files ?? []))}
      />
      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((m, i) => (
            <li
              key={`${m.url}-${i}`}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate">{m.filename}</span>
                <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {KIND_LABEL[m.type]}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                className="shrink-0 text-muted-foreground hover:text-red-400"
                aria-label={`Remover ${m.filename}`}
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length < STAGE_MAX_ATTACHMENTS && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            void addFiles(Array.from(e.dataTransfer.files ?? []))
          }}
          disabled={uploading}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs transition-colors disabled:opacity-50',
            dragOver
              ? 'border-primary bg-primary/5 text-foreground'
              : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
          )}
        >
          {uploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Enviando…
            </>
          ) : (
            <>
              <Paperclip className="h-4 w-4" />
              {items.length > 0 ? 'Adicionar mais anexos' : 'Anexar imagem, PDF ou documento (opcional)'}
            </>
          )}
        </button>
      )}
      {!isEmail && items.length > 1 && (
        <p className="text-[11px] text-muted-foreground">
          No WhatsApp cada anexo vira uma mensagem — o texto vai junto do primeiro.
        </p>
      )}
      {!isEmail && hasText && items.length > 0 && items.every((m) => m.type === 'audio') && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          Áudio não leva legenda — o texto vai numa mensagem separada.
        </p>
      )}
    </div>
  )
}
