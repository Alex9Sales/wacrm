// ============================================================
// Account-level (workspace-wide) settings — a thin typed wrapper over the
// `account_settings.settings` jsonb blob. One row per account; missing rows
// or keys fall back to DEFAULTS so callers never deal with nulls.
// ============================================================

import { eq } from 'drizzle-orm'

import { db, accountSettings } from '@/db'
import { firstOrNull } from '@/db/helpers'

/** One weekday's opening window. `open`/`close` are "HH:MM" (24h) in the
 *  account's business timezone; null on either side means closed all day. */
export interface BusinessDay {
  open: string | null
  close: string | null
}

export interface AccountSettings {
  /** Prefix outbound agent messages with the sender's name (WhatsApp
   *  shows it in bold), so the customer knows who is replying. */
  agentSignatureEnabled: boolean
  /** Transcribe inbound audio/voice notes to text (uses the account's
   *  OpenAI key). Off by default — it has a per-minute cost. */
  audioTranscriptionEnabled: boolean
  /** Auto-reassign an assigned conversation to another agent when it waits
   *  too long for a reply (SLA). Off by default (impactful). */
  autoReassignEnabled: boolean
  /** Minutes without an agent reply before auto-reassign kicks in. */
  autoReassignMinutes: number
  /** Auto-reply when a customer writes outside business hours. Off by default. */
  businessHoursEnabled: boolean
  /** Per-weekday opening windows, index 0=Sunday … 6=Saturday. */
  businessDays: BusinessDay[]
  /** IANA timezone the windows are evaluated in. */
  businessTimezone: string
  /** The message auto-sent (once per closed period) outside business hours. */
  outOfHoursMessage: string
  /** Send a 1–5 satisfaction survey when a conversation is closed. Off by default. */
  csatEnabled: boolean
  /** The survey question sent on close. */
  csatQuestion: string
  /** The thank-you sent after the customer replies with a score. */
  csatThanks: string
  /** Prompt asking for an optional free-text comment after the score. */
  csatCommentPrompt: string
  /** Master switch for receiving WhatsApp calls in the CRM (the ringing
   *  modal). On by default. When off, no inbound call rings any browser —
   *  for teams that answer on the phone itself. Admin/supervisor-controlled
   *  in Configurações → Notificações. */
  crmCallingEnabled: boolean
  /** Negócio ABERTO parado nesta MESMA etapa por mais dias que isto vira
   *  "esfriando" (alerta no card + filtro no funil). 0 = desligado. Padrão 7. */
  staleDealDays: number
  /** CDL: ao marcar um negócio como GANHO, registra a compra no histórico
   *  (customer_transactions). Ligado por padrão; desligue em contas que já
   *  sincronizam o histórico de um ERP (evita duplicar na re-importação). */
  recordSaleOnWon: boolean
  /** 🛑 Fase 8 — KILL SWITCH da autonomia. Quando true, NENHUMA ação autônoma
   *  (modo Automático) dispara na conta, independente da config dos agentes.
   *  Freio de emergência. Padrão false (não pausado). */
  autonomyPaused: boolean
  /** Cadência que inscreve o contato ao marcar o negócio como GANHO
   *  (pós-venda/onboarding). null = nenhuma. */
  wonCadenceId: string | null
  /** Cadência ao marcar como PERDIDO (recuperação). null = nenhuma. */
  lostCadenceId: string | null
  /** Funil→funil (ideia do cliente Dentai, 26/08): ao GANHAR, abre um novo
   *  negócio no funil escolhido (ex.: pós-venda). null = não move. */
  wonPipelineId: string | null
  /** Ao PERDER, abre um novo negócio no funil escolhido (ex.: resgate). */
  lostPipelineId: string | null
  /** Motivos de perda da conta (estilo RD): os chips oferecidos ao marcar
   *  perda. Motivo novo digitado num "Confirmar perda" entra aqui sozinho
   *  (criado na hora, fica pra próxima) — a menos que a lista esteja travada. */
  lostReasons: string[]
  /** Lista de motivos FECHADA (estilo RD "barra fechado"): vendedor só
   *  escolhe um chip, sem texto livre; só o admin edita a lista na Config.
   *  Evita duplicata por acento/grafia poluindo o relatório. */
  lostReasonsLocked: boolean
  /** Quando o admin dispensou o wizard "Ative seu Fluxia" (ISO). null = visível. */
  onboardingHiddenAt: string | null
  /** 📣 Avisos do responsável no WhatsApp (estilo "grupo da empresa"):
   *  telefone que RECEBE ('' = desligado), canal de envio (null = 1º WhatsApp
   *  conectado) e quais eventos avisam. Tudo OFF por padrão. */
  alertPhone: string
  alertChannelId: string | null
  /** Avisar quando um negócio for marcado como GANHO (resumo da venda). */
  alertOnWon: boolean
  /** Avisar quando a IA transferir um atendimento pra humano (com resumo). */
  alertOnHandoff: boolean
  /** Avisar quando um cliente marcar horário pela página pública de agenda. */
  alertOnBooking: boolean
  /** Avisar quando a IA confirmar um PEDIDO (criou card com valor/resumo) —
   *  o "manda no grupo do despacho" da Família do Gás. */
  alertOnOrder: boolean
  /** Avisar quando o SDR marcar um TESTE/DEMONSTRAÇÃO (via [[AVISARDONO:]]). */
  alertOnDemo: boolean
  /** Templates dos avisos ('' = padrão do sistema). Variáveis {{assim}} por
   *  evento — ver DEFAULT_ALERT_TEMPLATES em lib/alerts/owner-alerts. */
  alertWonTemplate: string
  alertHandoffTemplate: string
  alertBookingTemplate: string
  alertOrderTemplate: string
  alertDemoTemplate: string
  /** Sócio IA — resumo diário do funil enviado no WhatsApp do dono.
   *  OFF por padrão (dispara mensagem real). */
  ownerDigestEnabled: boolean
  /** Hora (0–23) do envio, avaliada no `businessTimezone` da conta. Padrão 8h. */
  ownerDigestHour: number
  /** Telefone (WhatsApp) que RECEBE o resumo. Vazio = não envia. */
  ownerDigestPhone: string
  /** Canal WhatsApp de origem do envio. null = 1º canal WhatsApp conectado. */
  ownerDigestChannelId: string | null
  /** Marcador anti-duplicação: 'YYYY-MM-DD' (no fuso da conta) do último envio.
   *  Escrito SÓ pelo worker — chave separada pra o save da UI não sobrescrever. */
  ownerDigestLastSent: string | null
}

/** Mon–Fri 08:00–18:00, weekend closed. Index 0=Sunday … 6=Saturday. */
const DEFAULT_BUSINESS_DAYS: BusinessDay[] = [
  { open: null, close: null }, // Sun
  { open: '08:00', close: '18:00' }, // Mon
  { open: '08:00', close: '18:00' }, // Tue
  { open: '08:00', close: '18:00' }, // Wed
  { open: '08:00', close: '18:00' }, // Thu
  { open: '08:00', close: '18:00' }, // Fri
  { open: null, close: null }, // Sat
]

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  agentSignatureEnabled: false,
  audioTranscriptionEnabled: false,
  autoReassignEnabled: false,
  autoReassignMinutes: 5,
  businessHoursEnabled: false,
  businessDays: DEFAULT_BUSINESS_DAYS,
  // Horário de Brasília — padrão nacional (cobre a maioria). Cada conta troca
  // pelo fuso da sua região em Configurações → Atendimento.
  businessTimezone: 'America/Sao_Paulo',
  outOfHoursMessage:
    'Olá! No momento estamos fora do horário de atendimento. Assim que abrirmos, retornamos sua mensagem. 🙏',
  csatEnabled: false,
  csatQuestion:
    'Como você avalia nosso atendimento? Responda com uma nota de 1 a 5 (sendo 5 = ótimo). 🙏',
  csatThanks: 'Obrigado pela sua avaliação! 💜',
  csatCommentPrompt:
    'Obrigado pela nota! Se quiser, deixe um comentário sobre o atendimento — é rapidinho. 🙏',
  crmCallingEnabled: true,
  staleDealDays: 7,
  recordSaleOnWon: true,
  autonomyPaused: false,
  wonCadenceId: null,
  lostCadenceId: null,
  wonPipelineId: null,
  lostPipelineId: null,
  lostReasons: [
    'Não responde',
    'Achou caro',
    'Comprou concorrente',
    'Sem orçamento agora',
    'Preferiu esperar',
  ],
  lostReasonsLocked: false,
  onboardingHiddenAt: null,
  alertPhone: '',
  alertChannelId: null,
  alertOnWon: false,
  alertOnHandoff: false,
  alertOnBooking: false,
  alertOnOrder: false,
  alertOnDemo: false,
  alertWonTemplate: '',
  alertHandoffTemplate: '',
  alertBookingTemplate: '',
  alertOrderTemplate: '',
  alertDemoTemplate: '',
  ownerDigestEnabled: false,
  ownerDigestHour: 8,
  ownerDigestPhone: '',
  ownerDigestChannelId: null,
  ownerDigestLastSent: null,
}

/** Read an account's settings, merged over the defaults. */
export async function getAccountSettings(
  accountId: string,
): Promise<AccountSettings> {
  const row = firstOrNull(
    await db
      .select({ settings: accountSettings.settings })
      .from(accountSettings)
      .where(eq(accountSettings.accountId, accountId))
      .limit(1),
  )
  const stored = (row?.settings ?? {}) as Partial<AccountSettings>
  return { ...DEFAULT_ACCOUNT_SETTINGS, ...stored }
}

/** Upsert a partial patch onto an account's settings. */
export async function updateAccountSettings(
  accountId: string,
  patch: Partial<AccountSettings>,
): Promise<AccountSettings> {
  const current = await getAccountSettings(accountId)
  const next = { ...current, ...patch }
  await db
    .insert(accountSettings)
    .values({ accountId, settings: next })
    .onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { settings: next, updatedAt: new Date().toISOString() },
    })
  return next
}
