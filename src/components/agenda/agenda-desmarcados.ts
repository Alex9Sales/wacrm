// ============================================================
// 🚫 Desmarcados na grade da Agenda (02/10/2026).
//
// Numa clínica com uma agenda do Google por profissional, a dona achou que a
// agenda "estava duplicando": ao lado da consulta de verdade aparecia outra
// igual. Era a linha CANCELADA — o sync marca 'cancelled' a cópia que ficou
// para trás quando o evento é movido de agenda no Google (a varredura de
// fantasmas) —, desenhada igualzinho a uma confirmada.
//
// listEvents continua trazendo tudo (o modal de um desmarcado abre); a GRADE
// esconde os desmarcados por padrão, com o controle "Mostrar desmarcados" —
// estado só da tela, volta escondido a cada visita. Mostrados, saem riscados
// e esmaecidos, e o tooltip começa por "Desmarcado".
//
// Puro (sem React): testado em agenda-desmarcados.test.ts.
// ============================================================

export function ehDesmarcado(ev: { status: string }): boolean {
  return ev.status === 'cancelled'
}

/** Entra na grade? Desmarcado só com "Mostrar desmarcados" ligado. */
export function visivelNaGrade(ev: { status: string }, mostrarDesmarcados: boolean): boolean {
  return mostrarDesmarcados || !ehDesmarcado(ev)
}

/** Quantos desmarcados há no período carregado (na agenda do filtro, se houver). */
export function contarDesmarcados(
  evs: Array<{ status: string; calendarId: string }>,
  calendarFilter: string | null,
): number {
  return evs.filter((ev) => ehDesmarcado(ev) && (!calendarFilter || ev.calendarId === calendarFilter)).length
}

/** O tooltip de um compromisso na grade: o desmarcado diz isso primeiro. */
export function tooltipComStatus(ev: { status: string }, tooltip: string): string {
  return ehDesmarcado(ev) ? `Desmarcado — ${tooltip}` : tooltip
}

/**
 * Riscado e esmaecido: dá para ver que existiu, mas não parece ocupar o
 * horário. Vazio para os de pé.
 */
export function classeDoDesmarcado(ev: { status: string }): string {
  return ehDesmarcado(ev) ? 'line-through opacity-50' : ''
}

/**
 * O aviso de lembrete travado não vale para desmarcado: ele não recebe
 * lembrete nenhum, e o triângulo na grade gritaria por nada.
 */
export function avisoDeLembreteNaGrade<B>(ev: { status: string; reminderBlock: B | null }): B | null {
  return ehDesmarcado(ev) ? null : ev.reminderBlock
}
