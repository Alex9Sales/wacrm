import { beforeEach, describe, expect, it, vi } from 'vitest';

// 02/10/2026 — o SLA avisava "Atendimento demorando" a cada janela (5 min) e
// passava a mesma conversa de A para B e de volta para A, sem parar, enquanto
// o cliente esperava. Aqui o "banco" é um mundo em memória e o relógio anda
// de minuto em minuto, como o tick do worker. Dados 100% fictícios.

import { computeWaitState, type WalkRow } from './queries';
import {
  runSlaReassignForAccount,
  SLA_ALERT_TITLE,
  SLA_REASSIGN_TITLE,
  type SlaConversation,
  type SlaMemory,
  type SlaStore,
} from './sla';

const ACC = 'conta-teste';
const DONO = 'dono';
const ADMIN = 'admin';
const A = 'agente-a';
const B = 'agente-b';
const C = 'agente-c';
const SETOR = 'setor-1';
const CONV = 'conversa-1';

const T0 = Date.parse('2026-09-30T13:00:00.000Z');
const min = (m: number) => T0 + m * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Msg extends WalkRow {
  senderType: 'customer' | 'agent' | 'bot';
}
interface Notif {
  userId: string;
  type: 'sla_alert' | 'conversation_assigned';
  conversationId: string;
  title: string;
  createdAt: string;
  reason?: string;
}

/** Banco de mentira com as mesmas regras que o SLA usa no de verdade. */
function makeWorld(opts: { sector?: string[] } = {}) {
  const w = {
    now: T0,
    messages: [] as Msg[],
    notifications: [] as Notif[],
    convs: new Map<string, SlaConversation>(),
    members: [
      { userId: DONO, role: 'owner' },
      { userId: ADMIN, role: 'admin' },
      { userId: A, role: 'agent' },
      { userId: B, role: 'agent' },
      { userId: C, role: 'agent' },
    ],
    sector: opts.sector ?? [A, B],
  };

  const say = (conversationId: string, senderType: Msg['senderType'], at: number, isInternal = false) =>
    w.messages.push({
      conversationId,
      senderType,
      senderId: senderType === 'customer' ? null : A,
      createdAt: iso(at),
      isInternal,
    });

  /** Atribuição feita por gente/roteamento: o gatilho do banco grava o genérico. */
  const assign = (conversationId: string, userId: string, at: number) => {
    const c = w.convs.get(conversationId)!;
    c.assignedAgentId = userId;
    c.assignedAt = iso(at);
    w.notifications.push({
      userId,
      type: 'conversation_assigned',
      conversationId,
      title: 'Nova conversa atribuída',
      createdAt: iso(at),
    });
  };

  const openConv = (id: string, agent: string, at: number, sectorId: string | null = SETOR) => {
    w.convs.set(id, { id, assignedAgentId: null, assignedAt: null, sectorId, contactId: null });
    assign(id, agent, at);
  };

  const store: SlaStore = {
    async waitState() {
      const since = w.now - 7 * 86_400_000;
      const rows = w.messages
        .filter((m) => Date.parse(m.createdAt!) >= since && Date.parse(m.createdAt!) <= w.now)
        .sort(
          (x, y) =>
            x.conversationId.localeCompare(y.conversationId) ||
            Date.parse(x.createdAt!) - Date.parse(y.createdAt!),
        );
      return computeWaitState(rows);
    },
    async openAssignedConversations() {
      return [...w.convs.values()].filter((c) => c.assignedAgentId).map((c) => ({ ...c }));
    },
    async members() {
      return w.members;
    },
    async sectorMemberIds() {
      return w.sector;
    },
    async hasSlaAlertSince({ conversationId, sinceIso, userIds }) {
      return w.notifications.some(
        (n) =>
          n.type === 'sla_alert' &&
          n.title === SLA_ALERT_TITLE &&
          n.conversationId === conversationId &&
          userIds.includes(n.userId) &&
          n.createdAt >= sinceIso,
      );
    },
    async assignmentsSince({ conversationId, sinceIso, userIds }) {
      return w.notifications
        .filter(
          (n) =>
            n.type === 'conversation_assigned' &&
            n.conversationId === conversationId &&
            userIds.includes(n.userId) &&
            n.createdAt >= sinceIso,
        )
        .map((n) => ({ userId: n.userId, createdAt: n.createdAt, bySla: n.title === SLA_REASSIGN_TITLE }));
    },
    async holderBefore({ conversationId, beforeIso, notBeforeIso, userIds }) {
      const prev = w.notifications.filter(
        (n) =>
          n.type === 'conversation_assigned' &&
          n.conversationId === conversationId &&
          userIds.includes(n.userId) &&
          n.createdAt >= notBeforeIso &&
          n.createdAt < beforeIso,
      );
      return prev.length ? prev[prev.length - 1].userId : null;
    },
    async reassign({ conversationId, fromAgentId, toAgentId }) {
      const c = w.convs.get(conversationId)!;
      if (c.assignedAgentId !== fromAgentId) return false;
      c.assignedAgentId = toAgentId;
      c.assignedAt = iso(w.now);
      w.notifications.push({
        userId: toAgentId,
        type: 'conversation_assigned',
        conversationId,
        title: SLA_REASSIGN_TITLE,
        createdAt: iso(w.now),
      });
      return true;
    },
    async insertSlaAlert({ conversationId, userIds, reason }) {
      for (const userId of userIds) {
        w.notifications.push({
          userId,
          type: 'sla_alert',
          conversationId,
          title: SLA_ALERT_TITLE,
          createdAt: iso(w.now),
          reason,
        });
      }
    },
  };

  let memory: SlaMemory = new Map();
  /** Roda o tick de minuto em minuto até `toMin` (inclusive), janela de 5 min.
   *  `restart` = memória do worker zerada a cada tick (deploy no meio). */
  const runUntil = async (fromMin: number, toMin: number, restart = false) => {
    for (let m = fromMin; m <= toMin; m++) {
      w.now = min(m);
      if (restart) memory = new Map();
      await runSlaReassignForAccount(ACC, 5, { store, memory, now: w.now });
    }
  };

  const alerts = (conversationId = CONV) =>
    w.notifications.filter((n) => n.type === 'sla_alert' && n.conversationId === conversationId);
  const slaMoves = (conversationId = CONV) =>
    w.notifications.filter(
      (n) =>
        n.type === 'conversation_assigned' &&
        n.conversationId === conversationId &&
        n.title === SLA_REASSIGN_TITLE,
    );

  return { w, say, assign, openConv, store, runUntil, alerts, slaMoves };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('computeWaitState — o episódio de espera', () => {
  const row = (senderType: string, m: number, isInternal = false): WalkRow => ({
    conversationId: CONV,
    senderType,
    senderId: senderType === 'customer' ? null : A,
    createdAt: iso(min(m)),
    isInternal,
  });

  it('abre na 1ª mensagem do cliente sem resposta (as seguintes não mexem no início)', () => {
    const s = computeWaitState([row('customer', 0), row('customer', 3)]);
    expect(s.pendingByConv.get(CONV)).toBe(min(0));
  });

  it('resposta do atendente encerra; cliente de novo abre OUTRO episódio', () => {
    expect(computeWaitState([row('customer', 0), row('agent', 2)]).pendingByConv.has(CONV)).toBe(false);
    const s = computeWaitState([row('customer', 0), row('agent', 2), row('customer', 10)]);
    expect(s.pendingByConv.get(CONV)).toBe(min(10));
    expect(s.agentRepliedConvs.has(CONV)).toBe(true);
  });

  it('mensagem da IA (bot) chega ao cliente: encerra, mas não conta como "atendente já falou"', () => {
    const s = computeWaitState([row('customer', 0), row('bot', 1)]);
    expect(s.pendingByConv.has(CONV)).toBe(false);
    expect(s.agentRepliedConvs.has(CONV)).toBe(false);
  });

  it('nota interna não chega ao cliente: não encerra a espera nem conta como resposta', () => {
    const s = computeWaitState([row('customer', 0), row('agent', 1, true), row('bot', 2, true)]);
    expect(s.pendingByConv.get(CONV)).toBe(min(0));
    expect(s.agentRepliedConvs.has(CONV)).toBe(false);
  });
});

describe('SLA — aviso "Atendimento demorando" (atendente já tinha respondido)', () => {
  function engagedWorld() {
    const t = makeWorld();
    t.openConv(CONV, A, min(-120));
    t.say(CONV, 'customer', min(-61));
    t.say(CONV, 'agent', min(-60));
    t.say(CONV, 'customer', min(0)); // abre o episódio
    return t;
  }

  it('avisa UMA vez por episódio — nada na 2ª, 3ª… janela (era um a cada ~6 min)', async () => {
    const t = engagedWorld();
    await t.runUntil(1, 4);
    expect(t.alerts()).toHaveLength(0); // ainda dentro da janela

    await t.runUntil(5, 5);
    expect(t.alerts().map((n) => n.userId).sort()).toEqual([ADMIN, DONO]); // um por admin

    await t.runUntil(6, 60); // 2ª, 3ª, … 11ª janela
    expect(t.alerts()).toHaveLength(2);
    expect(new Set(t.alerts().map((n) => n.reason))).toEqual(new Set(['engaged']));
    expect(t.slaMoves()).toHaveLength(0); // conversa engajada não é redistribuída
  });

  it('memória do worker zerada (deploy) não repete: o banco lembra', async () => {
    const t = engagedWorld();
    await t.runUntil(1, 40, true);
    expect(t.alerts()).toHaveLength(2);
  });

  it('aviso de antes do conserto, já dentro do episódio, também segura', async () => {
    const t = engagedWorld();
    // O código antigo já tinha avisado no minuto 5 (só um admin, tanto faz).
    t.w.notifications.push({
      userId: DONO,
      type: 'sla_alert',
      conversationId: CONV,
      title: SLA_ALERT_TITLE,
      createdAt: iso(min(5)),
    });
    await t.runUntil(6, 30, true);
    expect(t.alerts()).toHaveLength(1);
  });

  it('atendente respondeu → episódio acabou; cliente escreveu de novo → avisa de novo (uma vez)', async () => {
    const t = engagedWorld();
    await t.runUntil(1, 20);
    expect(t.alerts()).toHaveLength(2);

    t.say(CONV, 'agent', min(21));
    await t.runUntil(21, 40); // ninguém esperando: nada acontece
    expect(t.alerts()).toHaveLength(2);

    t.say(CONV, 'customer', min(41)); // episódio novo
    await t.runUntil(41, 45);
    expect(t.alerts()).toHaveLength(2); // dentro da janela do episódio novo
    await t.runUntil(46, 90);
    expect(t.alerts()).toHaveLength(4); // +1 aviso (2 admins), e só
  });
});

describe('SLA — redistribuição (ninguém respondeu ainda)', () => {
  function newLeadWorld(sector?: string[]) {
    const t = makeWorld({ sector });
    t.say(CONV, 'customer', min(0));
    t.openConv(CONV, A, min(0) + 1_000); // roteamento atribui na chegada
    return t;
  }

  it('redistribui UMA vez e não devolve para quem tinha (antes: A→B→A→B a cada 6 min)', async () => {
    const t = newLeadWorld();
    await t.runUntil(1, 5);
    expect(t.slaMoves()).toHaveLength(0); // janela de A ainda não fechou

    await t.runUntil(6, 6);
    expect(t.slaMoves()).toHaveLength(1);
    expect(t.slaMoves()[0].userId).toBe(B);
    expect(t.w.convs.get(CONV)!.assignedAgentId).toBe(B);
    expect(t.alerts()).toHaveLength(0);

    await t.runUntil(7, 10); // B ainda dentro da janela dele
    expect(t.alerts()).toHaveLength(0);

    await t.runUntil(11, 120); // B também não respondeu, por quase 2 horas
    expect(t.slaMoves()).toHaveLength(1); // nunca mais troca
    expect(t.w.convs.get(CONV)!.assignedAgentId).toBe(B);
    expect(t.alerts()).toHaveLength(2); // sobe para os admins, uma vez
    expect(t.alerts()[0].reason).toBe('after_reassign');
  });

  it('memória zerada a cada tick (deploy): a marca no banco segura o vaivém', async () => {
    const t = newLeadWorld();
    await t.runUntil(1, 120, true);
    expect(t.slaMoves()).toHaveLength(1);
    expect(t.w.convs.get(CONV)!.assignedAgentId).toBe(B);
    expect(t.alerts()).toHaveLength(2);
  });

  it('nunca devolve para quem já teve a conversa no episódio, mesmo sendo o menos carregado', async () => {
    const t = makeWorld({ sector: [A, B, C] });
    // C está bem mais carregada que A — o critério antigo escolheria A.
    for (const id of ['outra-1', 'outra-2', 'outra-3']) t.openConv(id, C, min(-300));
    t.openConv(CONV, A, min(-24 * 60)); // A estava com ela quando o cliente escreveu
    t.say(CONV, 'customer', min(0));
    t.assign(CONV, B, min(2)); // alguém passou para B à mão, dentro da janela

    await t.runUntil(1, 60);
    expect(t.slaMoves().map((n) => n.userId)).toEqual([C]);
    expect(t.w.convs.get(CONV)!.assignedAgentId).toBe(C);
  });

  it('sem mais ninguém no setor: avisa os admins uma vez, sem trocar', async () => {
    const t = newLeadWorld([A]);
    await t.runUntil(1, 60);
    expect(t.slaMoves()).toHaveLength(0);
    expect(t.alerts()).toHaveLength(2);
    expect(t.alerts()[0].reason).toBe('no_candidate');
  });

  it('conversa que já estava no vaivém antes do conserto: no máximo mais uma troca, e para', async () => {
    const t = newLeadWorld();
    // O vaivém antigo (gatilho genérico, sem a marca do SLA): A→B→A.
    t.assign(CONV, B, min(6));
    t.assign(CONV, A, min(12));
    await t.runUntil(13, 120);
    // A e B já tiveram a conversa neste episódio: ninguém sobra → só o aviso.
    expect(t.slaMoves()).toHaveLength(0);
    expect(t.w.convs.get(CONV)!.assignedAgentId).toBe(A);
    expect(t.alerts()).toHaveLength(2);
    expect(t.alerts()[0].reason).toBe('after_reassign'); // já rodou de mão em mão
  });

  it('resposta do atendente encerra o episódio; quando o cliente volta, é aviso (uma vez), não troca', async () => {
    const t = newLeadWorld();
    await t.runUntil(1, 20);
    expect(t.slaMoves()).toHaveLength(1); // A → B
    expect(t.alerts()).toHaveLength(2); // B também não respondeu na janela

    t.say(CONV, 'agent', min(21)); // B respondeu: episódio encerrado
    await t.runUntil(21, 40);
    expect(t.slaMoves()).toHaveLength(1);
    expect(t.alerts()).toHaveLength(2);

    // Cliente volta. B já falou com ele → conversa engajada: só aviso.
    t.say(CONV, 'customer', min(41));
    await t.runUntil(41, 100);
    expect(t.slaMoves()).toHaveLength(1);
    expect(t.alerts()).toHaveLength(4); // 2 do 1º episódio + 2 deste
  });

  it('episódio novo (a IA respondeu no meio) pode redistribuir de novo — uma vez', async () => {
    const t = newLeadWorld();
    await t.runUntil(1, 6);
    expect(t.slaMoves().map((n) => n.userId)).toEqual([B]);

    t.say(CONV, 'bot', min(7)); // a IA respondeu: encerra sem "engajar"
    await t.runUntil(7, 19);
    expect(t.alerts()).toHaveLength(0);

    t.say(CONV, 'customer', min(20)); // episódio novo: B está com ela desde antes
    await t.runUntil(20, 24);
    expect(t.slaMoves()).toHaveLength(1);
    await t.runUntil(25, 90);
    expect(t.slaMoves().map((n) => n.userId)).toEqual([B, A]); // uma troca neste episódio
    expect(t.alerts()).toHaveLength(2); // e A também não respondeu → aviso único
  });
});
