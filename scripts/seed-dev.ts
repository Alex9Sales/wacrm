// ============================================================
// Dev database seed — Phase 2 (Better Auth + organization tenancy).
//
// Seeds the dev DB with a fixed, deterministic dataset on the new
// auth model:
//   1 Better Auth user (dev@fluxia.local / "fluxia-dev-123")
//   1 credential account (scrypt-hashed password)
//   1 organization ("Fluxia Dev", default_currency BRL)
//   1 owner member linking user → org
//   1 channel (Meta "WhatsApp Oficial", disconnected, encrypted dummy creds)
//   1 pipeline with 3 stages · 5 contacts (+5511…) · 2 tags
//   2 conversations with a few messages each
//
// Idempotent: every row uses a fixed UUID and the domain tree hangs
// off the organization, so deleting the org (cascade) + the user
// wipes the previous run before re-inserting.
//
// Run:  npm run seed:dev   (requires DATABASE_URL + ENCRYPTION_KEY
// in .env.local). Prints DEV_SEED_USER_ID at the end — add it to
// .env.local so the dev session fallback authenticates as this user.
// ============================================================

import { config } from 'dotenv';

config({ path: '.env.local' });

// Fixed UUIDs — the whole point is determinism across runs.
const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222'; // = organization.id
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333';
const MEMBER_ID = '99999999-9999-4999-8999-000000000001';
const CHANNEL_ID = '44444444-4444-4444-8444-444444444444';
const PIPELINE_ID = '55555555-5555-4555-8555-555555555555';

const DEV_EMAIL = 'dev@fluxia.local';
const DEV_PASSWORD = 'fluxia-dev-123';

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
    user,
    account,
    organization,
    member,
    contacts,
    conversations,
    messages,
    pipelineStages,
    pipelines,
    tags,
    channels,
  } = await import('../src/db');
  const { encryptCredentials } = await import('../src/lib/channels/channels');
  const crypto = await import('crypto');
  const { hashPassword } = await import('better-auth/crypto');

  // ---- wipe the previous seed run ----
  // Deleting the organization cascades the whole domain tree; deleting
  // the user cascades its account/session/member rows.
  await db.delete(organization).where(eq(organization.id, ACCOUNT_ID));
  await db.delete(user).where(eq(user.id, USER_ID));

  // ---- Better Auth user + credential account ----
  await db.insert(user).values({
    id: USER_ID,
    name: 'Fluxia Dev',
    email: DEV_EMAIL,
    emailVerified: true,
  });

  await db.insert(account).values({
    id: CREDENTIAL_ID,
    userId: USER_ID,
    // For the credential provider Better Auth stores the userId as the
    // provider account id.
    accountId: USER_ID,
    providerId: 'credential',
    password: await hashPassword(DEV_PASSWORD),
  });

  // ---- organization (tenant) + owner member ----
  await db.insert(organization).values({
    id: ACCOUNT_ID,
    name: 'Fluxia Dev',
    slug: 'fluxia-dev',
    default_currency: 'BRL',
  });

  await db.insert(member).values({
    id: MEMBER_ID,
    userId: USER_ID,
    organizationId: ACCOUNT_ID,
    role: 'owner',
  });

  // ---- channel (Meta, disconnected, encrypted dummy credentials) ----
  await db.insert(channels).values({
    id: CHANNEL_ID,
    accountId: ACCOUNT_ID,
    provider: 'meta',
    name: 'WhatsApp Oficial',
    status: 'disconnected',
    // Credentials are a single encrypted JSON blob (provider-specific).
    credentials: encryptCredentials({
      accessToken: 'dev-dummy',
      verifyToken: 'dev-verify',
    }),
    providerMeta: {
      phone_number_id: 'dev-phone-number-id',
      waba_id: 'dev-waba-id',
    },
    webhookSecret: crypto.randomBytes(24).toString('hex'),
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
      channelId: CHANNEL_ID,
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
      channelId: CHANNEL_ID,
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
  console.log(`  user:     ${DEV_EMAIL} / ${DEV_PASSWORD}`);
  console.log(`  org:      Fluxia Dev (${ACCOUNT_ID})`);
  console.log(`  channel:  WhatsApp Oficial / meta (${CHANNEL_ID})`);
  console.log('');
  console.log(`DEV_SEED_USER_ID=${USER_ID}`);
  console.log('');
  console.log('Add the line above to .env.local so the dev session fallback');
  console.log('(src/lib/auth/session.ts) authenticates dev requests as the');
  console.log('seeded owner user when there is no real cookie session.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-dev] failed:', err);
    process.exit(1);
  });
