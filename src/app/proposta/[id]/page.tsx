// ============================================================
// /proposta/[id] — PÁGINA PÚBLICA da proposta (sem auth).
// Serve DOIS papéis: (1) link compartilhável que o lead abre no navegador
// e (2) fonte do "PDF limpo" (o botão Baixar PDF chama window.print() desta
// página, que já é só a proposta — não o CRM inteiro). O id é um uuid
// não-adivinhável (token). Documento forçado ao visual "papel" (claro),
// independente do tema, pra imprimir bonito.
// ============================================================
import type { Metadata } from 'next'

import { getPublicProposalData } from '@/lib/proposals/proposal'
import {
  formatProposalMoney,
  formatProposalDate,
  type ProposalData,
} from '@/lib/proposals/shared'
import { PrintBar } from './print-bar'

export const metadata: Metadata = {
  title: 'Proposta comercial',
}

export default async function PublicProposalPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await getPublicProposalData(id)

  if (!data) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-100 p-6">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">
            Proposta não encontrada
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Este link pode ter expirado ou está incorreto. Peça uma nova proposta ao
            seu contato comercial.
          </p>
        </div>
      </main>
    )
  }

  const shareUrl = `${(process.env.APP_URL || 'https://crm.salestecnologia.com.br').replace(/\/$/, '')}/proposta/${id}`

  return (
    <main className="min-h-screen bg-slate-100 py-8 px-4 print:bg-white print:py-0 print:px-0">
      <PrintBar shareUrl={shareUrl} />
      <ProposalDocument data={data} />
    </main>
  )
}

function ProposalDocument({ data }: { data: ProposalData }) {
  const money = (n: number) => formatProposalMoney(n, data.currency)
  const { seller, client, items, fields, totals } = data
  const createdDate = data.createdAt
    ? formatProposalDate(data.createdAt.slice(0, 10))
    : null

  return (
    <article
      className="mx-auto w-full max-w-[820px] bg-white text-slate-900 shadow-lg rounded-xl overflow-hidden print:shadow-none print:rounded-none print:max-w-none"
      style={{ printColorAdjust: 'exact', WebkitPrintColorAdjust: 'exact' }}
    >
      {/* Cabeçalho: marca do vendedor × identificação da proposta */}
      <header className="flex items-start justify-between gap-6 border-b border-slate-200 bg-slate-50 px-10 py-8 print:px-8">
        <div className="min-w-0">
          {seller.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={seller.logo}
              alt={seller.name}
              className="mb-3 h-12 w-auto max-w-[220px] object-contain"
            />
          ) : null}
          <h1 className="text-xl font-bold leading-tight text-slate-900">
            {seller.name}
          </h1>
          {seller.tagline ? (
            <p className="mt-1 max-w-sm text-sm text-slate-500">{seller.tagline}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Proposta comercial
          </div>
          <div className="mt-1 text-lg font-bold text-slate-900">Nº {data.number}</div>
          {createdDate ? (
            <div className="mt-1 text-xs text-slate-500">Emitida em {createdDate}</div>
          ) : null}
        </div>
      </header>

      <div className="px-10 py-8 print:px-8">
        {/* Cliente */}
        {(client.name || client.document || client.email || client.phone) && (
          <section className="mb-8">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Para
            </div>
            <div className="mt-1 text-base font-semibold text-slate-900">
              {client.name ?? '—'}
            </div>
            <div className="mt-1 space-y-0.5 text-sm text-slate-600">
              {client.document ? <div>CNPJ/CPF: {client.document}</div> : null}
              {client.email ? <div>{client.email}</div> : null}
              {client.phone ? <div>{client.phone}</div> : null}
              {client.address ? <div>{client.address}</div> : null}
            </div>
          </section>
        )}

        {/* Título do negócio */}
        {data.dealTitle ? (
          <h2 className="mb-4 text-lg font-semibold text-slate-900">{data.dealTitle}</h2>
        ) : null}

        {/* Itens */}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-slate-300 text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="py-2 pr-3 font-semibold">Item</th>
              <th className="py-2 px-3 text-right font-semibold">Qtd</th>
              <th className="py-2 px-3 text-right font-semibold">Preço un.</th>
              <th className="py-2 pl-3 text-right font-semibold">Subtotal</th>
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map((it, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2.5 pr-3 text-slate-800">{it.name}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">
                    {it.quantity}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">
                    {money(it.unitPrice)}
                  </td>
                  <td className="py-2.5 pl-3 text-right font-medium tabular-nums text-slate-900">
                    {money(it.subtotal)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="py-6 text-center text-slate-400">
                  Sem itens nesta proposta.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Totais */}
        <div className="mt-6 flex justify-end">
          <div className="w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between text-slate-600">
              <span>Subtotal</span>
              <span className="tabular-nums">{money(totals.subtotal)}</span>
            </div>
            {totals.discountValue > 0 ? (
              <div className="flex justify-between text-emerald-700">
                <span>
                  Desconto
                  {fields.discountType === 'percent' ? ` (${fields.discount}%)` : ''}
                </span>
                <span className="tabular-nums">− {money(totals.discountValue)}</span>
              </div>
            ) : null}
            <div className="mt-2 flex justify-between border-t border-slate-300 pt-2 text-base font-bold text-slate-900">
              <span>Total</span>
              <span className="tabular-nums">{money(totals.total)}</span>
            </div>
          </div>
        </div>

        {/* Validade */}
        {fields.validUntil ? (
          <div className="mt-8 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Proposta válida até{' '}
            <strong>{formatProposalDate(fields.validUntil)}</strong>.
          </div>
        ) : null}

        {/* Condições / termos */}
        {fields.terms ? (
          <section className="mt-8">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Condições
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
              {fields.terms}
            </p>
          </section>
        ) : null}

        {/* Formas de pagamento (do perfil da empresa) */}
        {seller.paymentMethods ? (
          <section className="mt-6">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Formas de pagamento
            </div>
            <p className="mt-1 text-sm text-slate-600">{seller.paymentMethods}</p>
          </section>
        ) : null}
      </div>

      <footer className="border-t border-slate-200 px-10 py-5 text-center text-xs text-slate-400 print:px-8">
        {seller.name} · Proposta Nº {data.number}
      </footer>
    </article>
  )
}
