// ============================================================
// Dev database seed — Phase 1 (Supabase → Drizzle migration).
//
// Seeds the dev DB with a fixed, deterministic dataset:
//   1 account ("Fluxia Dev") · 1 user (fixed UUID) · 1 owner profile
//   1 whatsapp_config (disconnected, encrypted dummy token)
//   1 pipeline with 3 stages · 5 contacts (+5511…) · 2 tags
//   2 conversations with a few messages each
//
// Idempotent: every row uses a fixed UUID and the whole tree hangs
// off the account, so a `DELETE FROM accounts WHERE id = …` cascade
// wipes the previous run before re-inserting.
//
// Run:  npm run seed:dev   (requires DATABASE_URL + ENCRYPTION_KEY
// in .env.local). Prints DEV_SEED_USER_ID at the end — add it to
// .env.local so the Phase 1 session stub authenticates as this user.
// ============================================================

import { config } from 'dotenv';

config({ path: '.env.local' });

// Fixed UUIDs — the whole point is determinism across runs.
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const PROFILE_ID = '33333333-3333-4333-8333-333333333333';
const WHATSAPP_CONFIG_ID = '44444444-4444-4444-8444-444444444444';
const PIPELINE_ID = '55555555-5555-4555-8555-555555555555';

const STAGE_IDS = [
  '55555555-5555-4555-8555-000000000001',
  '55555555-5555-4555-8555-000000000002',
  '55555555-5555-4555-8555-000000000003',
];

const CONTACT_IDS = [
  '66666666-6666-4666-8666-000000000001',
  '66666666-6666-4666-8666-000000000002',
  '66666666-6666-4666-8666-000000000003',
  '66666666-6666-4666-8666-000000000004',
  '66666666-6666-4666-8666-000000000005',
];

const TAG_IDS = [
  '77777777-7777-4777-8777-000000000001',
  '77777777-7777-4777-8777-000000000002',
];

const CONVERSATION_IDS = [
  '88888888-8888-4888-8888-000000000001',
  '88888888-8888-4888-8888-000000000002',
];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — add it to .env.local');
  }
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is not set — add it to .env.local');
  }

  // Dynamic imports so dotenv runs before any module reads its env
  // vars at load time (encryption.ts reads ENCRYPTION_KEY on import).
  const { eq } = await import('drizzle-orm');
  const {
    db,
    accounts,
    contacts,
    conversations,
    messages,
    pipelineStages,
    pipelines,
    profiles,
    tags,
    whatsappConfig,
  } = await import('../src/db');
  const { encrypt } = await import('../src/lib/whatsapp/encryption');

  // ---- wipe the previous seed run (cascade covers the whole tree) ----
  await db.delete(accounts).where(eq(accounts.id, ACCOUNT_ID));

  // ---- account + profile ----
  await db.insert(accounts).values({
    id: ACCOUNT_ID,
    name: 'Fluxia Dev',
    ownerUserId: USER_ID,
    defaultCurrency: 'BRL',
  });

  await db.insert(profiles).values({
    id: PROFILE_ID,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    accountRole: 'owner',
    fullName: 'Fluxia Dev',
    email: 'dev@fluxia.local',
  });

  // ---- whatsapp config (disconnected, encrypted dummy token) ----
  await db.insert(whatsappConfig).values({
    id: WHATSAPP_CONFIG_ID,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    phoneNumberId: 'dev-phone-number-id',
    wabaId: 'dev-waba-id',
    accessToken: encrypt('dev-dummy-access-token'),
    verifyToken: 'dev-verify-token',
    status: 'disconnected',
  });

  // ---- pipeline + 3 stages ----
  await db.insert(pipelines).values({
    id: PIPELINE_ID,
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    name: 'Pipeline de Vendas',
  });

  await db.insert(pipelineStages).values([
    { id: STAGE_IDS[0], pipelineId: PIPELINE_ID, name: 'Novo Lead', position: 0, color: '#3b82f6' },
    { id: STAGE_IDS[1], pipelineId: PIPELINE_ID, name: 'Em Negociação', position: 1, color: '#f59e0b' },
    { id: STAGE_IDS[2], pipelineId: PIPELINE_ID, name: 'Fechado', position: 2, color: '#22c55e' },
  ]);

  // ---- 5 contacts (+5511 numbers) ----
  const contactSeed = [
    { id: CONTACT_IDS[0], name: 'Ana Souza', phone: '+5511910000001', email: 'ana@example.com', company: 'Padaria Estrela' },
    { id: CONTACT_IDS[1], name: 'Bruno Lima', phone: '+5511910000002', email: 'bruno@example.com', company: 'Lima Construções' },
    { id: CONTACT_IDS[2], name: 'Carla Mendes', phone: '+5511910000003', email: 'carla@example.com', company: 'Estética Bella' },
    { id: CONTACT_IDS[3], name: 'Diego Rocha', phone: '+5511910000004', email: 'diego@example.com', company: 'Rocha Imóveis' },
    { id: CONTACT_IDS[4], name: 'Elisa Prado', phone: '+5511910000005', email: 'elisa@example.com', company: 'Prado Advocacia' },
  ];
  await db.insert(contacts).values(
    contactSeed.map((c) => ({
      ...c,
      userId: USER_ID,
      accountId: ACCOUNT_ID,
    }))
  );

  // ---- 2 tags ----
  await db.insert(tags).values([
    { id: TAG_IDS[0], userId: USER_ID, accountId: ACCOUNT_ID, name: 'Cliente', color: '#22c55e' },
    { id: TAG_IDS[1], userId: USER_ID, accountId: ACCOUNT_ID, name: 'Lead', color: '#3b82f6' },
  ]);

  // ---- 2 conversations with a few messages each ----
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

  await db.insert(conversations).values([
    {
      id: CONVERSATION_IDS[0],
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      contactId: CONTACT_IDS[0],
      status: 'open',
      lastMessageText: 'Perfeito, obrigado!',
      lastMessageAt: at(5),
      unreadCount: 1,
    },
    {
      id: CONVERSATION_IDS[1],
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      contactId: CONTACT_IDS[1],
      status: 'open',
      lastMessageText: 'Pode me enviar o orçamento?',
      lastMessageAt: at(60),
      unreadCount: 1,
    },
  ]);

  await db.insert(messages).values([
    // Conversation 1 — Ana
    { conversationId: CONVERSATION_IDS[0], senderType: 'customer', contentType: 'text', contentText: 'Olá! Vocês têm horário amanhã?', status: 'delivered', createdAt: at(30) },
    { conversationId: CONVERSATION_IDS[0], senderType: 'agent', senderId: USER_ID, contentType: 'text', contentText: 'Oi Ana! Temos sim, às 14h. Posso confirmar?', status: 'read', createdAt: at(20) },
    { conversationId: CONVERSATION_IDS[0], senderType: 'customer', contentType: 'text', contentText: 'Perfeito, obrigado!', status: 'delivered', createdAt: at(5) },
    // Conversation 2 — Bruno
    { conversationId: CONVERSATION_IDS[1], senderType: 'customer', contentType: 'text', contentText: 'Bom dia, vi o anúncio de vocês.', status: 'delivered', createdAt: at(120) },
    { conversationId: CONVERSATION_IDS[1], senderType: 'agent', senderId: USER_ID, contentType: 'text', contentText: 'Bom dia, Bruno! Como posso ajudar?', status: 'read', createdAt: at(90) },
    { conversationId: CONVERSATION_IDS[1], senderType: 'customer', contentType: 'text', contentText: 'Pode me enviar o orçamento?', status: 'delivered', createdAt: at(60) },
  ]);

  console.log('Seed complete.');
  console.log('');
  console.log(`DEV_SEED_USER_ID=${USER_ID}`);
  console.log('');
  console.log('Add the line above to .env.local so the Phase 1 session stub');
  console.log('(src/lib/auth/session.ts) authenticates dev requests as the');
  console.log('seeded owner user.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-dev] failed:', err);
    process.exit(1);
  });
