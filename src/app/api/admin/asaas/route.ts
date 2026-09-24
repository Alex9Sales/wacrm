// ============================================================
// GET /api/admin/asaas — o que existe no Asaas, pra vincular à conta.
//
// 24/09: vários clientes foram cadastrados no Asaas na mão, antes de existir
// a assinatura pelo CRM — o Renato com um parcelamento de 6× R$ 1.298,50 da
// implantação, o João com uma cobrança avulsa do agente. O painel mostrava
// esse dinheiro como zero porque nada no CRM apontava pra lá. Esta rota é o
// que a tela de vínculo consulta: acha o cliente e lista o que ele já tem.
//
//   ?q=<nome | e-mail | CPF/CNPJ>  → clientes
//   ?customer=<id>                 → assinaturas, parcelamentos e a próxima
//                                    cobrança em aberto daquele cliente
//
// Só leitura, e só platform-admin. Nada aqui cria ou cobra nada.
// ============================================================

import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import {
  listCustomerInstallments,
  listCustomerSubscriptions,
  nextOpenCharge,
  searchCustomers,
} from '@/lib/billing/asaas'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin()
    const { searchParams } = new URL(request.url)
    const customer = searchParams.get('customer')?.trim()

    if (customer) {
      // Uma falha em qualquer lista não pode derrubar as outras: o admin
      // ainda consegue vincular pelo que veio.
      const [subs, installments, next] = await Promise.all([
        listCustomerSubscriptions(customer).catch(() => []),
        listCustomerInstallments(customer).catch(() => []),
        nextOpenCharge(customer).catch(() => null),
      ])
      return NextResponse.json({ subscriptions: subs, installments, nextCharge: next })
    }

    const q = searchParams.get('q')?.trim() ?? ''
    if (q.length < 3) {
      return NextResponse.json({ customers: [], hint: 'Digite ao menos 3 letras.' })
    }
    return NextResponse.json({ customers: await searchCustomers(q) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
