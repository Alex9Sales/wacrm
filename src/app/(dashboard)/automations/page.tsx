import Link from "next/link"
import { ArrowRight, MessageCircle, Workflow } from "lucide-react"

// ============================================================
// Página "Automações" — agora focada SÓ nas automações de comentário do
// Instagram (comentou palavra-chave → responde + DM com botões). O antigo
// construtor linear (gatilho→ação) foi aposentado: os fluxos com botões,
// etapas e múltiplos canais vivem no construtor visual "Fluxos".
// ============================================================

export default function AutomationsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Automações</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Responda automaticamente aos comentários dos seus posts no Instagram.
        </p>
      </div>

      <Link
        href="/automations/comentarios"
        className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] text-white">
          <MessageCircle className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-foreground">
            Automações de comentário (Instagram)
          </span>
          <span className="block text-xs text-muted-foreground">
            Comentou uma palavra-chave num post → o CRM responde o comentário e
            manda um DM com botões (link, comunidade…). Escolha o post de cada
            automação.
          </span>
        </span>
        <ArrowRight className="h-4 w-4 shrink-0 text-primary" />
      </Link>

      <div className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-card/40 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Workflow className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            Procurando fluxos com botões, etapas e vários canais?
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Os fluxos visuais (WhatsApp, Instagram e Messenger) agora vivem em{" "}
            <Link
              href="/flows"
              className="font-medium text-primary hover:underline"
            >
              Fluxos
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
