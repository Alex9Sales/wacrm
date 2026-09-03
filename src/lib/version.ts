// ============================================================
// Build identity — used by the "nova versão disponível" banner e por TODA a
// recuperação de bundle velho (auto-reload, banner, overlay, retry de Server
// Action). O cliente guarda o id com que carregou e sonda `/api/version`;
// quando o servidor reporta OUTRO id, a aba está num bundle velho e recarrega.
//
// ⚠️ 03/09/2026 — POR QUE NÃO USAMOS MAIS O `.next/BUILD_ID`: o id do Next
// veio IDÊNTICO em deploys diferentes (`build-TfctsWXpff2fKS` no c0784f2 e no
// ce51a1b, com 6 deploys entre eles). Como a comparação era sempre "igual",
// NADA disso disparava: a aba antiga ficava batendo numa Server Action que não
// existe mais (85 erros em 30 min no log, ~8/min, contínuos) e o cliente via a
// tela travada — a dor recorrente do Dentai/Lorrayne/Felipe/GoLink.
//
// `DEPLOYMENT_ID` é o SHA do commit, injetado no build (Dockerfile ARG/ENV) e
// presente no runtime; é o MESMO id que assina os assets (`?dpl=…`) e o skew
// protection do Next. Ele muda a cada deploy — por isso é a fonte da verdade
// aqui, com o BUILD_ID do Next como reserva (dev local / build sem a env).
// ============================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | null = null;

/** The current deployment's id (stable until the next deploy). */
export function getBuildId(): string {
  if (cached) return cached;
  const deploymentId = (process.env.DEPLOYMENT_ID || '').trim();
  if (deploymentId && deploymentId !== 'dev') {
    cached = deploymentId;
    return cached;
  }
  try {
    cached = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
  } catch {
    // `next dev` has no BUILD_ID file — fall back to a dev sentinel so the
    // banner stays dormant locally.
    cached = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';
  }
  return cached || 'dev';
}
