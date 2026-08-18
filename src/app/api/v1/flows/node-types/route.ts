// ============================================================
// GET /api/v1/flows/node-types — catálogo dos tipos de nó   (scope: flows:read)
//
// Referência machine-readable de TUDO que dá pra montar num fluxo: cada tipo de
// nó, sua categoria e os campos do `config` (incluindo as arestas = node_key do
// próximo nó). É o que um agente lê pra construir automações via a API de Fluxos.
// Rota estática (tem precedência sobre /flows/{id}).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { okList, toApiErrorResponse } from '@/lib/api/v1/respond'
import { FLOW_NODE_CATALOG } from '@/lib/flows/node-catalog'

export async function GET(request: Request) {
  try {
    await requireApiKey(request, 'flows:read')
    return okList(FLOW_NODE_CATALOG, null)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}
