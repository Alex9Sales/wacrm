'use client'

import { useState } from 'react'
import { Printer, Check, Link2 } from 'lucide-react'

// Barra de ações da proposta pública (não sai na impressão). "Baixar PDF"
// dispara o print do navegador (Salvar como PDF) da página LIMPA; "Copiar
// link" copia a própria URL pública pra compartilhar.
export function PrintBar({ shareUrl }: { shareUrl: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard indisponível — ignora */
    }
  }

  return (
    <div className="print:hidden fixed top-4 right-4 z-10 flex gap-2">
      <button
        onClick={copy}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
      >
        {copied ? <Check size={16} className="text-emerald-600" /> : <Link2 size={16} />}
        {copied ? 'Copiado!' : 'Copiar link'}
      </button>
      <button
        onClick={() => window.print()}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
      >
        <Printer size={16} />
        Baixar PDF
      </button>
    </div>
  )
}
