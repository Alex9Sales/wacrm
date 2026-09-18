// ============================================================
// Janela do "mesmo pedido" — UMA regra para as duas travas da IA:
//   • external-tools.ts: escrita repetida (criar_pedido) na mesma conversa;
//   • close-actions.ts: card no funil da mesma conversa, mesmo já ganho.
//
// 16/09 (Alex, Família do Gás): 10 horas. Um comprador pediu "pago às 17h",
// pagou 9h45 depois e a IA criou OUTRO pedido no ERP e OUTRO card — a trava
// era de 6 h e o card só contava enquanto estivesse aberto (a equipe arrasta
// pra Ganho em minutos). Segundo botijão no mesmo dia, na mesma conversa,
// dentro da janela, fica com a equipe.
// ============================================================

export const SAME_ORDER_WINDOW_MS = 10 * 60 * 60 * 1000
