import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// 02/10/2026 — o SLA avisava "Atendimento demorando" a cada janela (5 min) e
// passava a mesma conversa de A para B e de volta para A, sem parar, enquanto
// o cliente esperava. Aqui o "banco" é um mundo em memória e o relógio anda
// de minuto em minuto, como o tick do worker. Dados 100% fictícios.
//
// Revisão (02/10/2026): espera mais longa que a janela de 7 dias do passeio
// (a âncora) e a corrida "atendente respondeu no meio do tick". O banco de
// verdade só aparece no fim, falso, para conferir o SQL da redistribuição.

const h = vi.hoisted(() => {
  const s = {
    updateWhere: null as unknown,
    updateRows: [] as { id: string }[],
    inserted: [] as unknown[],
    selectWhere: null as unknown,
    selectRows: [] as unknown[],
  };
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const k of ['from', 'innerJoin', 'orderBy']) c[k] = () => c;
    c.where = (w: unknown) => {
      s.selectWhere = w;
      return c;
    };
    c.limit = async () => s.selectRows;
    return c;
  };
  const tx = {
    execute: async () => ({}),
    update: () => ({
      set: () => ({
        where: (w: unknown) => {
          s.updateWhere = w;
          return { returning: async () => s.updateRows };
        },
      }),
    }),
    insert: () => ({
      values: async (v: unknown) => {
        s.inserted.push(v);
      },
    }),
  };
  const db = {
    select: () => chain(),
    transaction: async (cb: (t: typeof tx) => unknown) => cb(tx),
  };
  return { s, db, publish: vi.fn() };
});

vi.mock('@/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db')>()),
  db: h.db,
}));
vi.mock('@/lib/events/publish', () => ({ publishEvent: h.publish }));

import { computeWaitState, type WalkRow } from './queries';
import {
  dbSlaStore,
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
    calls: { lastReplyBefore: 0 },
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
    async lastReplyBefore({ conversationId, beforeIso }) {
      w.calls.lastReplyBefore += 1;
      const antes = w.messages
        .filter(
          (m) =>
            m.conversationId === conversationId &&
            m.senderType !== 'customer' &&
            !m.isInternal &&
            m.createdAt! < beforeIso,
        )
        .map((m) => m.createdAt!)
        .sort();
      return antes.at(-1) ?? null;
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
    async reassign({ conversationId, fromAgentId, toAgentId, episodeStartIso }) {
      const c = w.convs.get(conversationId)!;
      if (c.assignedAgentId !== fromAgentId) return false;
      // Mesma regra do UPDATE de verdade: alguém respondeu desde o início da
      // espera → não troca (nem grava a marca).
      const respondeu = w.messages.some(
        (m) =>
          m.conversationId === conversationId &&
          m.senderType !== 'customer' &&
          !m.isInternal &&
          m.createdAt! >= episodeStartIso,
      );
      if (respondeu) return false;
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

  /** Um tick só, num instante qualquer (pular dias sem rodar minuto a minuto). */
  const runAt = async (at: number, restart = false) => {
    w.now = at;
    if (restart) memory = new Map();
    await runSlaReassignForAccount(ACC, 5, { store, memory, now: w.now });
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

  return { w, say, assign, openConv, store, runUntil, runAt, alerts, slaMoves };
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

  it('espera sem nenhuma resposta antes dela na janela pode vir de antes da janela', () => {
    // Só cliente (e nota interna) na janela: o início real pode ser mais antigo.
    expect(
      computeWaitState([row('agent', 0, true), row('customer', 1), row('customer', 2)]).pendingMaybeOlder.has(CONV),
    ).toBe(true);
    // Houve resposta na janela: o início visto é o real.
    expect(
      computeWaitState([row('customer', 0), row('agent', 1), row('customer', 2)]).pendingMaybeOlder.has(CONV),
    ).toBe(false);
    // Ninguém esperando: nada.
    expect(computeWaitState([row('customer', 0), row('bot', 1)]).pendingMaybeOlder.size).toBe(0);
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

describe('SLA — espera mais longa que a janela de 7 dias (âncora)', () => {
  const DIA = 24 * 60;

  /** Lead novo que ninguém respondeu: A → B (min 6), aviso (min 11). O
   *  cliente segue escrevendo no dia 3 e no dia 6 — e ninguém responde. */
  async function leadParado() {
    const t = makeWorld();
    t.say(CONV, 'customer', min(0));
    t.openConv(CONV, A, min(0) + 1_000);
    await t.runUntil(1, 20);
    expect(t.slaMoves().map((n) => n.userId)).toEqual([B]);
    expect(t.alerts()).toHaveLength(2);
    t.say(CONV, 'customer', min(3 * DIA));
    t.say(CONV, 'customer', min(6 * DIA));
    return t;
  }

  it('a 1ª mensagem sai da janela: nada de novo aviso nem troca de volta para A', async () => {
    const t = await leadParado();
    // 7 dias + 1 min: a mensagem do min 0 saiu da janela; o início visto pula
    // para o dia 3. Antes do conserto: aviso de novo e B → A.
    await t.runAt(min(7 * DIA + 1));
    await t.runAt(min(7 * DIA + 30));
    // Dia 10: a do dia 3 também saiu; o início visto pula para o dia 6.
    await t.runAt(min(10 * DIA + 1));
    expect(t.slaMoves().map((n) => n.userId)).toEqual([B]);
    expect(t.w.convs.get(CONV)!.assignedAgentId).toBe(B);
    expect(t.alerts()).toHaveLength(2);
  });

  it('com a memória do worker zerada (deploy), a âncora vem do banco — uma consulta por episódio', async () => {
    const t = await leadParado();
    await t.runAt(min(7 * DIA + 1), true);
    expect(t.slaMoves()).toHaveLength(1);
    expect(t.alerts()).toHaveLength(2);

    // Depois de achar a âncora, a memória guarda: o início visto andar de
    // novo (dia 10) não reconsulta.
    const consultas = t.w.calls.lastReplyBefore;
    await t.runAt(min(7 * DIA + 2));
    await t.runAt(min(10 * DIA + 1));
    expect(t.w.calls.lastReplyBefore).toBe(consultas);
    expect(t.alerts()).toHaveLength(2);
  });

  it('conversa engajada: a resposta do atendente saiu da janela, mas não vira redistribuição', async () => {
    const t = makeWorld();
    t.openConv(CONV, A, min(-120));
    t.say(CONV, 'customer', min(-61));
    t.say(CONV, 'agent', min(-60));
    t.say(CONV, 'customer', min(0));
    await t.runUntil(1, 10);
    expect(t.alerts().map((n) => n.reason)).toEqual(['engaged', 'engaged']);

    t.say(CONV, 'customer', min(3 * DIA));
    // Na janela só sobram mensagens do cliente; a âncora é a resposta de -60.
    await t.runAt(min(7 * DIA + 1), true);
    expect(t.slaMoves()).toHaveLength(0);
    expect(t.alerts()).toHaveLength(2);
  });

  it('espera com resposta dentro da janela não consulta a âncora', async () => {
    const t = makeWorld();
    t.openConv(CONV, A, min(-120));
    t.say(CONV, 'customer', min(-61));
    t.say(CONV, 'agent', min(-60));
    t.say(CONV, 'customer', min(0));
    await t.runUntil(1, 30, true);
    expect(t.w.calls.lastReplyBefore).toBe(0);
  });
});

describe('SLA — atendente responde no meio do tick', () => {
  it('a resposta chega entre a leitura e a troca: não redistribui nem grava a marca', async () => {
    const t = makeWorld();
    t.say(CONV, 'customer', min(0));
    t.openConv(CONV, A, min(0) + 1_000);

    // O passeio de mensagens já foi lido; A responde antes do UPDATE.
    const membros = t.store.members.bind(t.store);
    let responder = true;
    t.store.members = async (accountId) => {
      if (responder && t.w.now >= min(6)) {
        responder = false;
        t.say(CONV, 'agent', t.w.now);
      }
      return membros(accountId);
    };

    await t.runUntil(1, 60);
    expect(t.slaMoves()).toHaveLength(0);
    expect(t.w.convs.get(CONV)!.assignedAgentId).toBe(A);
    expect(t.alerts()).toHaveLength(0);
  });
});

describe('SLA — banco de verdade (SQL conferido no texto)', () => {
  const dialect = new PgDialect();

  beforeEach(() => {
    h.s.updateWhere = null;
    h.s.updateRows = [];
    h.s.inserted = [];
    h.s.selectWhere = null;
    h.s.selectRows = [];
    h.publish.mockReset();
  });

  const pedido = {
    accountId: ACC,
    conversationId: CONV,
    contactId: null,
    fromAgentId: A,
    toAgentId: B,
    waitedMin: 6,
    episodeStartIso: iso(min(0)),
  };

  it('a troca só acontece se ninguém respondeu desde o início da espera', async () => {
    h.s.updateRows = [{ id: CONV }];
    expect(await dbSlaStore.reassign(pedido)).toBe(true);

    const q = dialect.sqlToQuery(h.s.updateWhere as SQL);
    const txt = q.sql.replace(/\s+/g, ' ');
    expect(txt).toContain('NOT EXISTS ( SELECT 1 FROM messages r WHERE r.conversation_id = $');
    expect(txt).toContain("r.sender_type <> 'customer' AND r.is_internal = false AND r.created_at >= $");
    expect(txt).not.toMatch(/--/);
    // Conta, conversa, dono lido e início da espera vão como parâmetro.
    expect(q.params).toEqual(expect.arrayContaining([ACC, CONV, A, iso(min(0))]));
    expect(h.s.inserted).toHaveLength(1);
    expect(h.s.inserted[0]).toMatchObject({ accountId: ACC, userId: B, title: SLA_REASSIGN_TITLE });
  });

  it('UPDATE sem linha (respondeu ou outra pessoa mexeu): sem marca e sem evento', async () => {
    h.s.updateRows = [];
    expect(await dbSlaStore.reassign(pedido)).toBe(false);
    expect(h.s.inserted).toHaveLength(0);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('âncora: última mensagem que chegou ao cliente antes da espera, presa à conta', async () => {
    h.s.selectRows = [{ at: '2026-09-20T10:00:00+00:00' }];
    const at = await dbSlaStore.lastReplyBefore({
      accountId: ACC,
      conversationId: CONV,
      beforeIso: iso(min(0)),
    });
    expect(at).toBe('2026-09-20T10:00:00+00:00');
    const q = dialect.sqlToQuery(h.s.selectWhere as SQL);
    expect(q.sql).toContain('"conversations"."account_id" = $');
    expect(q.sql).toContain('"messages"."sender_type" <> $');
    expect(q.sql).toContain('"messages"."is_internal" = $');
    expect(q.sql).toContain('"messages"."created_at" < $');
    expect(q.params).toEqual(expect.arrayContaining([ACC, CONV, 'customer', false, iso(min(0))]));

    h.s.selectRows = [];
    expect(
      await dbSlaStore.lastReplyBefore({ accountId: ACC, conversationId: CONV, beforeIso: iso(min(0)) }),
    ).toBeNull();
  });
});
