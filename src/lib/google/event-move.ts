// ============================================================
// 🔀 Trocar o compromisso de AGENDA sem deixar fantasma no Google.
//
// 01/10 (revisão do "paciente vai junto para o Google"). O select "Agenda" do
// modal manda o calendarId em todo salvamento. Quando ele MUDAVA, o push fazia
// PATCH na agenda NOVA com o id do evento da agenda ANTIGA, levava 404, recriava
// na nova — e o evento antigo ficava lá. No import seguinte da agenda antiga,
// ninguém no CRM tinha aquele (agenda, id), e nascia um compromisso NOVO no
// horário que não existe mais.
//
// Com o bloco do paciente na descrição, o fantasma leva o telefone: o import o
// liga ao paciente e o lembrete avisa de uma consulta que foi mudada. Ex.: a
// consulta das 14h na agenda da Dra. A passa para as 16h na agenda do Dr. B, e
// a paciente recebe o lembrete das 14h E o das 16h.
//
// Agora: grava a troca com o vínculo do Google zerado, apaga o evento na agenda
// antiga pelo id que estava gravado, e cria na agenda nova — se ela for do
// Google (agenda/actions.ts → updateEvent).
//
// Puro (sem banco) para dar para testar. Sem 'server-only'.
// ============================================================

export type AgendaDoEvento = {
  calendarId: string
  /** Id do evento no Google (null = nunca foi espelhado). */
  googleEventId: string | null
  /** A agenda sincroniza com o Google (tem id do Google e conexão)? */
  google: boolean
}

export type PlanoDaEdicao = {
  /** A agenda mudou de verdade. */
  trocou: boolean
  /** Apagar o evento que ficou na agenda ANTIGA do Google. */
  apagarNaAntiga: boolean
  /** O que espelhar no Google DEPOIS de gravar (null = nada). */
  pushDepois: 'update' | 'create' | null
}

/**
 * O que fazer no Google ao salvar a edição de um compromisso.
 *
 * `nova` = a agenda escolhida no salvamento (null quando não veio nenhuma:
 * a agenda não muda).
 */
export function planoDaEdicao(
  antes: AgendaDoEvento,
  nova: { calendarId: string; google: boolean } | null,
): PlanoDaEdicao {
  if (!nova || nova.calendarId === antes.calendarId) {
    return { trocou: false, apagarNaAntiga: false, pushDepois: 'update' }
  }
  return {
    trocou: true,
    // Só existe o que apagar se o evento chegou a ir para o Google antigo.
    apagarNaAntiga: antes.google && Boolean(antes.googleEventId),
    // Agenda nova local: só some da antiga.
    pushDepois: nova.google ? 'create' : null,
  }
}
