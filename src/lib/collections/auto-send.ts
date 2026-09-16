// ============================================================
// Política efetiva da régua com "Enviar sozinha" — PURO (testável).
//
// 16/09 (João/GoLink, Speed Gás sem aviso): "Enviar sozinha" só trocava o
// nível de collect_charges para automático. O teto genérico da orquestração
// continuava valendo: 20 por ação/dia (capFor, sem `caps` no agente) e 30
// mensagens automáticas. Depois do 20º envio do dia (~10h45) a régua parava
// de montar cobrança e lembrete novos — os 50 de Ajustar nunca valeram, e o
// lembrete barrado no dia do vencimento se perdia de vez.
// ============================================================

import { levelFor, type AutonomyPolicy } from '@/lib/orchestration/policy'

import type { CollectionsSettings } from './rules'

export function withAutoSend(policy: AutonomyPolicy, s: Pick<CollectionsSettings, 'autoSend' | 'dailyCap'>): AutonomyPolicy {
  // Automático pelo "Enviar sozinha" OU pela promoção ("Liberar automático",
  // que grava o nível no agente): nos dois, o teto é o de Ajustar.
  if (!s.autoSend && levelFor(policy, 'collect_charges') !== 'auto') return policy
  return {
    ...policy,
    levels: s.autoSend ? { ...policy.levels, collect_charges: 'auto' } : policy.levels,
    // O teto da régua é o de Ajustar (o sender confere de novo na hora de enviar).
    caps: { ...policy.caps, collect_charges: s.dailyCap },
    maxAutoMessagesPerDay: Math.max(policy.maxAutoMessagesPerDay, s.dailyCap),
  }
}
