import { pgTable, uniqueIndex, check, uuid, text, timestamp, index, foreignKey, unique, primaryKey, jsonb, integer, boolean, numeric, date, vector, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// tsvector is not a built-in drizzle column type; the column is a
// GENERATED ALWAYS STORED FTS column, read-only from app code.
const tsvector = customType<{ data: string }>({
	dataType() {
		return "tsvector";
	},
})

// ============================================================
// Better Auth tables (multi-tenancy = organization).
//
// Hand-written to mirror Better Auth 1.6.23's expected schema with
// uuid ids (advanced.database.generateId = "uuid"). Column NAMES use
// Better Auth's default camelCase-in-TS with snake_case DB names for
// multi-word columns. `organization` carries the extra
// `default_currency` additionalField. `member.role` is plain text
// (owner/admin/agent/viewer) — the app validates it via roles.ts.
// ============================================================

export const user = pgTable("user", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("user_email_key").on(table.email),
]);

export const session = pgTable("session", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	token: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	activeOrganizationId: uuid("active_organization_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_fkey"
		}).onDelete("cascade"),
	unique("session_token_key").on(table.token),
]);

export const account = pgTable("account", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_user_id_fkey"
		}).onDelete("cascade"),
]);

export const verification = pgTable("verification", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const organization = pgTable("organization", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	slug: text(),
	logo: text(),
	metadata: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// Property name MUST match the additionalField `fieldName` in
	// src/lib/auth.ts ("default_currency") — the Better Auth Drizzle
	// adapter resolves additionalFields by that key on the table object.
	default_currency: text("default_currency").default('USD').notNull(),
}, (table) => [
	unique("organization_slug_key").on(table.slug),
]);

export const member = pgTable("member", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	organizationId: uuid("organization_id").notNull(),
	role: text().default('member').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_member_organization").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	index("idx_member_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "member_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "member_organization_id_fkey"
		}).onDelete("cascade"),
]);

export const invitation = pgTable("invitation", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	inviterId: uuid("inviter_id").notNull(),
	organizationId: uuid("organization_id").notNull(),
	role: text(),
	status: text().default('pending').notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_invitation_organization").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "invitation_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.inviterId],
			foreignColumns: [user.id],
			name: "invitation_inviter_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// ORGANIZATION_BILLING — super-admin (Phase 8) billing satellite.
//
// 1:1 with `organization` (PK = organization_id, FK cascade). Holds
// the SaaS-operator (Fluxia) billing + status metadata that lives
// ABOVE the org's own data. `status` drives suspension enforcement in
// getCurrentAccount (status='suspended' → AccountSuspendedError).
// ============================================================
export const organizationBilling = pgTable("organization_billing", {
	organizationId: uuid("organization_id").primaryKey().notNull(),
	status: text().default('active').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	plan: text(),
	billingPhone: text("billing_phone"),
	notes: text(),
	lastReminderAt: timestamp("last_reminder_at", { withTimezone: true, mode: 'string' }),
	// Platform admin (Alex/Rafael) responsible for this client. Set on
	// provision, editable to transfer. Nullable, no FK (a removed admin just
	// makes the row show "—"). Drives the /admin "Responsável" column + filter.
	responsibleAdminId: uuid("responsible_admin_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "organization_billing_organization_id_fkey"
		}).onDelete("cascade"),
	check("organization_billing_status_check", sql`status = ANY (ARRAY['active'::text, 'suspended'::text, 'trial'::text])`),
]);

export const contacts = pgTable("contacts", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	phone: text().notNull(),
	phoneNormalized: text("phone_normalized").generatedAlwaysAs(sql`regexp_replace(phone, '\D'::text, ''::text, 'g'::text)`),
	name: text(),
	email: text(),
	company: text(),
	// Código(s) do cliente no ERP do cliente (múltiplos por contato). Exibido
	// ao lado do nome, editável, exportável/importável em CSV e via API v1.
	customerCodes: text("customer_codes").array().notNull().default(sql`'{}'::text[]`),
	avatarUrl: text("avatar_url"),
	// A "contact" that is actually a WhatsApp group (phone holds the group
	// jid's digits, name the group name). Only set for monitored groups.
	isGroup: boolean("is_group").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_contacts_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("idx_contacts_account_phone_normalized").using("btree", table.accountId.asc().nullsLast().op("text_ops"), table.phoneNormalized.asc().nullsLast().op("text_ops")).where(sql`(phone_normalized <> ''::text)`),
	index("idx_contacts_phone").using("btree", table.phone.asc().nullsLast().op("text_ops")),
	index("idx_contacts_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "contacts_account_id_fkey"
		}).onDelete("cascade"),
]);

export const tags = pgTable("tags", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	color: text().default('#3b82f6').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_tags_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "tags_account_id_fkey"
		}).onDelete("cascade"),
]);

export const contactTags = pgTable("contact_tags", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	tagId: uuid("tag_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_contact_tags_contact").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_contact_tags_tag").using("btree", table.tagId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_tags_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.tagId],
			foreignColumns: [tags.id],
			name: "contact_tags_tag_id_fkey"
		}).onDelete("cascade"),
	unique("contact_tags_contact_id_tag_id_key").on(table.contactId, table.tagId),
]);

export const customFields = pgTable("custom_fields", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	fieldName: text("field_name").notNull(),
	fieldType: text("field_type").default('text').notNull(),
	fieldOptions: jsonb("field_options"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_custom_fields_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "custom_fields_account_id_fkey"
		}).onDelete("cascade"),
]);

export const contactCustomValues = pgTable("contact_custom_values", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	customFieldId: uuid("custom_field_id").notNull(),
	value: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_custom_values_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.customFieldId],
			foreignColumns: [customFields.id],
			name: "contact_custom_values_custom_field_id_fkey"
		}).onDelete("cascade"),
	unique("contact_custom_values_contact_id_custom_field_id_key").on(table.contactId, table.customFieldId),
]);

export const contactNotes = pgTable("contact_notes", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	noteText: text("note_text").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_contact_notes_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_notes_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "contact_notes_account_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// CHANNELS — multi-provider WhatsApp (Phase 4). Replaces
// whatsapp_config. One row per connected WhatsApp channel
// (Meta / WAHA / Evolution / EvoGo). `credentials` is an
// AES-256-GCM-encrypted JSON blob whose shape depends on the
// provider (see docs/fase4-multicanal.md). Non-secret routing
// info (phone_number_id, waba_id, baseUrl, session/instance)
// lives in `provider_meta`.
//
// Defined before `conversations` so its channel_id FK can
// reference channels.id (Drizzle resolves FK targets eagerly).
// ============================================================
export const channels = pgTable("channels", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	provider: text().notNull(),
	name: text().notNull(),
	status: text().default('disconnected').notNull(),
	phoneNumber: text("phone_number"),
	// Encrypted JSON — provider-specific tokens/keys/session.
	credentials: text().notNull(),
	providerMeta: jsonb("provider_meta").default({}).notNull(),
	settings: jsonb().default({}).notNull(),
	// Phase 2 routing: new conversations that arrive on this channel are
	// routed to this sector by default (keyword matches on the first message
	// can still override). Null = no default → the general (null) queue. FK
	// to sectors is declared in the migration (sectors is defined below).
	defaultSectorId: uuid("default_sector_id"),
	// Per-channel token used to validate non-Meta webhook deliveries.
	webhookSecret: text("webhook_secret").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_channels_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	// Partial unique index for Meta inbound routing — resolve a channel
	// by provider_meta->>'phone_number_id'. Only meta channels carry one.
	uniqueIndex("channels_meta_pnid")
		.using("btree", sql`((provider_meta->>'phone_number_id'))`)
		.where(sql`(provider = 'meta'::text)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "channels_account_id_fkey"
		}).onDelete("cascade"),
	unique("channels_account_id_name_key").on(table.accountId, table.name),
	check("channels_provider_check", sql`provider = ANY (ARRAY['meta'::text, 'waha'::text, 'evolution'::text, 'evogo'::text])`),
	check("channels_status_check", sql`status = ANY (ARRAY['disconnected'::text, 'qr_pending'::text, 'connected'::text, 'error'::text])`),
]);

export const conversations = pgTable("conversations", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	// Phase 4: the channel this conversation belongs to. Nullable during
	// the migration window (legacy rows predate multi-channel); the
	// inbound pipeline always sets it. Uniqueness is one conversation per
	// (account_id, contact_id, channel_id).
	channelId: uuid("channel_id"),
	status: text().default('open').notNull(),
	// Conversation priority (Chatwoot-style). CHECK in
	// ('none','low','medium','high','urgent'); defaults to 'none'.
	priority: text().default('none').notNull(),
	assignedAgentId: uuid("assigned_agent_id"),
	// When the current agent was assigned — resets the SLA clock so a
	// just-reassigned conversation gives the new agent the full window.
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	// Sector (department) this conversation belongs to. NULL = general queue
	// (visible to everyone); otherwise only members of the sector see it.
	sectorId: uuid("sector_id"),
	// Handoff note written when the conversation was transferred to a sector —
	// shown to the receiving agent as a banner. Cleared on dismiss.
	transferNote: text("transfer_note"),
	transferNoteAt: timestamp("transfer_note_at", { withTimezone: true, mode: 'string' }),
	transferNoteBy: uuid("transfer_note_by"),
	// Set when a CSAT survey was sent on close and we're awaiting the 1–5 reply.
	csatPendingAt: timestamp("csat_pending_at", { withTimezone: true, mode: 'string' }),
	// The csat_responses id awaiting a free-text comment (next customer message).
	csatCommentPending: uuid("csat_comment_pending"),
	lastMessageText: text("last_message_text"),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }),
	unreadCount: integer("unread_count").default(0),
	aiAutoreplyDisabled: boolean("ai_autoreply_disabled").default(false).notNull(),
	aiReplyCount: integer("ai_reply_count").default(0).notNull(),
	// Private conversation (migration 0032): only the assigned agent, admins,
	// supervisors and explicit participants see it — hidden from the general
	// queue and from agents it isn't assigned to.
	isPrivate: boolean("is_private").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_conversations_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_conversations_contact_id").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_conversations_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_conversations_channel").using("btree", table.channelId.asc().nullsLast().op("uuid_ops")).where(sql`(channel_id IS NOT NULL)`),
	// One conversation per (account, contact, channel). Partial so legacy
	// rows with a NULL channel_id don't collide (NULLs are distinct in a
	// non-partial unique index anyway, but the predicate documents intent).
	uniqueIndex("conversations_account_contact_channel_key").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.contactId.asc().nullsLast().op("uuid_ops"), table.channelId.asc().nullsLast().op("uuid_ops")).where(sql`(channel_id IS NOT NULL)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "conversations_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "conversations_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "conversations_channel_id_fkey"
		}).onDelete("cascade"),
	check("conversations_status_check", sql`status = ANY (ARRAY['open'::text, 'pending'::text, 'closed'::text])`),
]);

// Histórico de ligações ("Ligações" panel, WhatsApp-style). One row per call
// on any transport (waha-voip or Meta). Inbound is born 'missed' and promoted
// to 'answered'/'rejected' by the call.accepted/rejected webhook; outbound is
// born 'dialing' and finalized by the modal's hangup.
export const callLogs = pgTable("call_logs", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id"),
	contactId: uuid("contact_id"),
	// Raw peer chatId (556…@c.us or …@lid) or E.164 digits.
	peer: text().notNull(),
	direction: text().notNull(),
	status: text().notNull(),
	provider: text().default('waha').notNull(),
	externalCallId: text("external_call_id"),
	durationSec: integer("duration_sec"),
	// The agent who took the call. Claimed atomically (UPDATE ... WHERE
	// claimed_by IS NULL) so only one of the ringing agents wins.
	claimedBy: uuid("claimed_by"),
	// When this leg finished. "Channel busy right now" = ended_at IS NULL.
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("call_logs_account_created").on(table.accountId, table.createdAt.desc()),
]);

export const messages = pgTable("messages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	senderType: text("sender_type").notNull(),
	senderId: uuid("sender_id"),
	contentType: text("content_type").default('text').notNull(),
	contentText: text("content_text"),
	mediaUrl: text("media_url"),
	templateName: text("template_name"),
	messageId: text("message_id"),
	status: text().default('sent').notNull(),
	replyToMessageId: uuid("reply_to_message_id"),
	interactiveReplyId: text("interactive_reply_id"),
	// Speech-to-text of an inbound audio/voice note (null until transcribed).
	transcription: text("transcription"),
	// WhatsApp "view once" media — persisted so an agent can re-open it.
	viewOnce: boolean("view_once").default(false).notNull(),
	// Internal note: written in the thread but never sent to the customer —
	// for @mentioning a colleague without leaving the conversation.
	isInternal: boolean("is_internal").default(false).notNull(),
	// GROUP messages only: the stable key of the participant who sent this
	// message (phone digits when known, else LID user-part) — same key space as
	// group_participant_names.wa_key. Lets the inbox render a per-author avatar
	// next to each group bubble. Null for 1:1 and for our own (fromMe) echoes.
	authorKey: text("author_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_messages_conversation").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	index("idx_messages_message_id").using("btree", table.messageId.asc().nullsLast().op("text_ops")),
	index("idx_messages_reply_to").using("btree", table.replyToMessageId.asc().nullsLast().op("uuid_ops")).where(sql`(reply_to_message_id IS NOT NULL)`),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "messages_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.replyToMessageId],
			foreignColumns: [table.id],
			name: "messages_reply_to_message_id_fkey"
		}).onDelete("set null"),
	check("messages_sender_type_check", sql`sender_type = ANY (ARRAY['customer'::text, 'agent'::text, 'bot'::text])`),
	check("messages_status_check", sql`status = ANY (ARRAY['sending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])`),
	check("messages_content_type_check", sql`content_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text, 'audio'::text, 'video'::text, 'location'::text, 'template'::text, 'interactive'::text])`),
]);

export const messageReactions = pgTable("message_reactions", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	messageId: uuid("message_id").notNull(),
	conversationId: uuid("conversation_id").notNull(),
	actorType: text("actor_type").notNull(),
	actorId: uuid("actor_id"),
	emoji: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_message_reactions_conversation").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_reactions_message").using("btree", table.messageId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "message_reactions_message_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "message_reactions_conversation_id_fkey"
		}).onDelete("cascade"),
	unique("message_reactions_message_id_actor_type_actor_id_key").on(table.messageId, table.actorType, table.actorId),
	check("message_reactions_actor_type_check", sql`actor_type = ANY (ARRAY['customer'::text, 'agent'::text])`),
]);

export const pipelines = pgTable("pipelines", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_pipelines_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "pipelines_account_id_fkey"
		}).onDelete("cascade"),
]);

export const messageTemplates = pgTable("message_templates", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	// Phase 4: templates only exist on Meta channels. Nullable during
	// migration; new templates bind to a meta channel.
	channelId: uuid("channel_id"),
	name: text().notNull(),
	category: text().default('Marketing').notNull(),
	language: text().default('en_US'),
	headerType: text("header_type"),
	headerContent: text("header_content"),
	bodyText: text("body_text").notNull(),
	footerText: text("footer_text"),
	buttons: jsonb(),
	status: text().default('DRAFT'),
	sampleValues: jsonb("sample_values"),
	metaTemplateId: text("meta_template_id"),
	rejectionReason: text("rejection_reason"),
	qualityScore: text("quality_score"),
	headerHandle: text("header_handle"),
	headerMediaUrl: text("header_media_url"),
	submissionError: text("submission_error"),
	lastSubmittedAt: timestamp("last_submitted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_message_templates_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_templates_meta_template_id").using("btree", table.metaTemplateId.asc().nullsLast().op("text_ops")).where(sql`(meta_template_id IS NOT NULL)`),
	uniqueIndex("message_templates_user_name_language_key").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.name.asc().nullsLast().op("uuid_ops"), table.language.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "message_templates_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "message_templates_channel_id_fkey"
		}).onDelete("cascade"),
	check("message_templates_category_check", sql`category = ANY (ARRAY['Marketing'::text, 'Utility'::text, 'Authentication'::text])`),
	check("message_templates_header_type_check", sql`header_type = ANY (ARRAY['text'::text, 'image'::text, 'video'::text, 'document'::text])`),
	check("message_templates_status_meta_check", sql`status = ANY (ARRAY['DRAFT'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'PAUSED'::text, 'DISABLED'::text, 'IN_APPEAL'::text, 'PENDING_DELETION'::text])`),
	check("message_templates_quality_score_check", sql`(quality_score IS NULL) OR (quality_score = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text]))`),
	check("message_templates_buttons_shape_check", sql`(buttons IS NULL) OR ((jsonb_typeof(buttons) = 'array'::text) AND (jsonb_array_length(buttons) <= 10))`),
]);

export const pipelineStages = pgTable("pipeline_stages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	pipelineId: uuid("pipeline_id").notNull(),
	name: text().notNull(),
	position: integer().default(0).notNull(),
	color: text().default('#3b82f6').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_pipeline_stages_pipeline").using("btree", table.pipelineId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.pipelineId],
			foreignColumns: [pipelines.id],
			name: "pipeline_stages_pipeline_id_fkey"
		}).onDelete("cascade"),
]);

export const deals = pgTable("deals", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	pipelineId: uuid("pipeline_id").notNull(),
	stageId: uuid("stage_id").notNull(),
	contactId: uuid("contact_id"),
	conversationId: uuid("conversation_id"),
	assignedTo: uuid("assigned_to"),
	title: text().notNull(),
	value: numeric({ precision: 12, scale:  2 }).default('0').notNull(),
	currency: text().default('USD'),
	notes: text(),
	expectedCloseDate: date("expected_close_date"),
	status: text().default('open'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_deals_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_deals_assigned_to").using("btree", table.assignedTo.asc().nullsLast().op("uuid_ops")),
	index("idx_deals_pipeline").using("btree", table.pipelineId.asc().nullsLast().op("uuid_ops")),
	index("idx_deals_stage").using("btree", table.stageId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "deals_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.pipelineId],
			foreignColumns: [pipelines.id],
			name: "deals_pipeline_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.stageId],
			foreignColumns: [pipelineStages.id],
			name: "deals_stage_id_fkey"
		}),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "deals_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "deals_conversation_id_fkey"
		}),
	foreignKey({
			columns: [table.assignedTo],
			foreignColumns: [user.id],
			name: "deals_assigned_to_fkey"
		}).onDelete("set null"),
	check("deals_status_check", sql`status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])`),
]);

export const broadcasts = pgTable("broadcasts", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	// Channel the broadcast sends on. Nullable so the worker can resolve
	// the channel after a restart (the channel used to live only in the
	// transient BroadcastPlan); falls back to the default channel when null.
	channelId: uuid("channel_id"),
	// 'template' = Meta approved-template broadcast (official). 'text' = a
	// free-text drip on a non-official channel (WAHA/Evolution/EvoGo),
	// humanized-paced. bodyText holds the message for 'text' broadcasts.
	messageKind: text("message_kind").default('template').notNull(),
	bodyText: text("body_text"),
	// Optional media attachment for a 'text' broadcast (image/video/document/
	// audio). mediaUrl is the public (proxy) URL the provider fetches.
	mediaUrl: text("media_url"),
	mediaType: text("media_type"),
	mediaFilename: text("media_filename"),
	// Pacing config for humanized 'text' drips: { dailyCap, startMin, endMin,
	// days:[1..6], offsetMin }. Null → send as fast as the throughput limiter
	// allows (template/burst path).
	pacing: jsonb(),
	// Nullable: 'text' broadcasts carry no Meta template.
	templateName: text("template_name"),
	templateLanguage: text("template_language").default('en_US').notNull(),
	templateVariables: jsonb("template_variables"),
	audienceFilter: jsonb("audience_filter"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	status: text().default('draft').notNull(),
	totalRecipients: integer("total_recipients").default(0),
	sentCount: integer("sent_count").default(0),
	deliveredCount: integer("delivered_count").default(0),
	readCount: integer("read_count").default(0),
	repliedCount: integer("replied_count").default(0),
	failedCount: integer("failed_count").default(0),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_broadcasts_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "broadcasts_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "broadcasts_channel_id_fkey"
		}).onDelete("set null"),
	check("broadcasts_status_check", sql`status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'paused'::text, 'cancelled'::text, 'sent'::text, 'failed'::text])`),
]);

export const broadcastRecipients = pgTable("broadcast_recipients", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	broadcastId: uuid("broadcast_id").notNull(),
	contactId: uuid("contact_id"),
	status: text().default('pending').notNull(),
	// Send attempts (queue retries). Reuses error_message for last error.
	attempts: integer().default(0).notNull(),
	// Per-recipient body params ({{1}}, {{2}}…) — persisted so the queue
	// worker can rebuild the template send after a process restart (they
	// used to live only in the transient BroadcastPlan).
	params: jsonb().default(sql`'[]'::jsonb`),
	// Structured per-send values (header text/media, URL/COPY_CODE button
	// values) — the dashboard's richer send path. Null for API sends that
	// only use positional `params`.
	messageParams: jsonb("message_params"),
	whatsappMessageId: text("whatsapp_message_id"),
	// Humanized drip: the computed instant this recipient should be sent.
	// Null for burst/template broadcasts (sent as fast as the limiter allows).
	scheduledSlotAt: timestamp("scheduled_slot_at", { withTimezone: true, mode: 'string' }),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	repliedAt: timestamp("replied_at", { withTimezone: true, mode: 'string' }),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_broadcast_recipients_broadcast").using("btree", table.broadcastId.asc().nullsLast().op("uuid_ops")),
	index("idx_broadcast_recipients_broadcast_status").using("btree", table.broadcastId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	uniqueIndex("idx_broadcast_recipients_wamid").using("btree", table.whatsappMessageId.asc().nullsLast().op("text_ops")).where(sql`(whatsapp_message_id IS NOT NULL)`),
	foreignKey({
			columns: [table.broadcastId],
			foreignColumns: [broadcasts.id],
			name: "broadcast_recipients_broadcast_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "broadcast_recipients_contact_id_fkey"
		}).onDelete("set null"),
	check("broadcast_recipients_status_check", sql`status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'replied'::text, 'failed'::text])`),
]);

export const automations = pgTable("automations", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	triggerType: text("trigger_type").notNull(),
	triggerConfig: jsonb("trigger_config").default({}).notNull(),
	isActive: boolean("is_active").default(false).notNull(),
	executionCount: integer("execution_count").default(0).notNull(),
	lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automations_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_automations_account_active_trigger").using("btree", table.accountId.asc().nullsLast().op("text_ops"), table.triggerType.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	index("idx_automations_active_trigger").using("btree", table.triggerType.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	index("idx_automations_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "automations_account_id_fkey"
		}).onDelete("cascade"),
]);

export const automationSteps = pgTable("automation_steps", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	automationId: uuid("automation_id").notNull(),
	parentStepId: uuid("parent_step_id"),
	branch: text(),
	stepType: text("step_type").notNull(),
	stepConfig: jsonb("step_config").default({}).notNull(),
	position: integer().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automation_steps_automation_id").using("btree", table.automationId.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	index("idx_automation_steps_parent").using("btree", table.parentStepId.asc().nullsLast().op("uuid_ops")).where(sql`(parent_step_id IS NOT NULL)`),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_steps_automation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentStepId],
			foreignColumns: [table.id],
			name: "automation_steps_parent_step_id_fkey"
		}).onDelete("cascade"),
	check("automation_steps_branch_check", sql`branch = ANY (ARRAY['yes'::text, 'no'::text])`),
]);

export const automationLogs = pgTable("automation_logs", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	automationId: uuid("automation_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id"),
	triggerEvent: text("trigger_event").notNull(),
	stepsExecuted: jsonb("steps_executed").default([]).notNull(),
	status: text().notNull(),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automation_logs_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_automation_logs_automation").using("btree", table.automationId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("idx_automation_logs_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_logs_automation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "automation_logs_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "automation_logs_contact_id_fkey"
		}).onDelete("set null"),
	check("automation_logs_status_check", sql`status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text])`),
]);

export const automationPendingExecutions = pgTable("automation_pending_executions", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	automationId: uuid("automation_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id"),
	logId: uuid("log_id"),
	parentStepId: uuid("parent_step_id"),
	branch: text(),
	nextStepPosition: integer("next_step_position").notNull(),
	context: jsonb().default({}).notNull(),
	status: text().default('pending').notNull(),
	runAt: timestamp("run_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automation_pending_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_automation_pending_due").using("btree", table.runAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_pending_executions_automation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "automation_pending_executions_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "automation_pending_executions_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.logId],
			foreignColumns: [automationLogs.id],
			name: "automation_pending_executions_log_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentStepId],
			foreignColumns: [automationSteps.id],
			name: "automation_pending_executions_parent_step_id_fkey"
		}).onDelete("set null"),
	check("automation_pending_executions_branch_check", sql`branch = ANY (ARRAY['yes'::text, 'no'::text])`),
	check("automation_pending_executions_status_check", sql`status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text])`),
]);

export const flows = pgTable("flows", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	status: text().default('draft').notNull(),
	triggerType: text("trigger_type").notNull(),
	triggerConfig: jsonb("trigger_config").default({}).notNull(),
	entryNodeId: text("entry_node_id"),
	// Optional channel binding. NULL = "todos os canais" (roda em qualquer
	// número/canal da conta, comportamento legado). Quando setado, o fluxo só
	// dispara em inbounds que chegam por ESSE canal — permite fluxos distintos
	// por canal (suporte, financeiro, Instagram…). Soft-ref (sem FK): se o
	// canal for excluído, o fluxo simplesmente para de casar (nenhum inbound
	// tem esse channel_id) em vez de silenciosamente virar "todos os canais".
	channelId: uuid("channel_id"),
	fallbackPolicy: jsonb("fallback_policy").default({"on_exhaust":"handoff","max_reprompts":2,"on_timeout_hours":24,"on_unknown_reply":"reprompt"}).notNull(),
	executionCount: integer("execution_count").default(0).notNull(),
	lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_flows_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_flows_account_active").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::text)`),
	index("idx_flows_active_trigger").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.triggerType.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::text)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "flows_account_id_fkey"
		}).onDelete("cascade"),
	check("flows_status_check", sql`status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])`),
	check("flows_trigger_type_check", sql`trigger_type = ANY (ARRAY['keyword'::text, 'first_inbound_message'::text, 'manual'::text])`),
]);

export const apiKeys = pgTable("api_keys", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	name: text().notNull(),
	keyPrefix: text("key_prefix").notNull(),
	keyHash: text("key_hash").notNull(),
	scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("api_keys_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("api_keys_key_hash_idx").using("btree", table.keyHash.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "api_keys_account_id_fkey"
		}).onDelete("cascade"),
	unique("api_keys_key_hash_key").on(table.keyHash),
]);

export const flowNodes = pgTable("flow_nodes", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	flowId: uuid("flow_id").notNull(),
	nodeKey: text("node_key").notNull(),
	nodeType: text("node_type").notNull(),
	config: jsonb().default({}).notNull(),
	positionX: integer("position_x").default(0).notNull(),
	positionY: integer("position_y").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_flow_nodes_flow").using("btree", table.flowId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.flowId],
			foreignColumns: [flows.id],
			name: "flow_nodes_flow_id_fkey"
		}).onDelete("cascade"),
	unique("flow_nodes_flow_id_node_key_key").on(table.flowId, table.nodeKey),
	check("flow_nodes_node_type_check", sql`node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text])`),
]);

export const flowRuns = pgTable("flow_runs", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	flowId: uuid("flow_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id"),
	conversationId: uuid("conversation_id"),
	status: text().default('active').notNull(),
	currentNodeKey: text("current_node_key"),
	lastPromptMessageId: uuid("last_prompt_message_id"),
	vars: jsonb().default({}).notNull(),
	repromptCount: integer("reprompt_count").default(0).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastAdvancedAt: timestamp("last_advanced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	endReason: text("end_reason"),
}, (table) => [
	index("idx_flow_runs_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_flow_runs_active_advanced").using("btree", table.lastAdvancedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'active'::text)`),
	index("idx_flow_runs_flow_started").using("btree", table.flowId.asc().nullsLast().op("uuid_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	uniqueIndex("idx_one_active_run_per_contact").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.contactId.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::text)`),
	foreignKey({
			columns: [table.flowId],
			foreignColumns: [flows.id],
			name: "flow_runs_flow_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "flow_runs_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "flow_runs_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "flow_runs_conversation_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lastPromptMessageId],
			foreignColumns: [messages.id],
			name: "flow_runs_last_prompt_message_id_fkey"
		}).onDelete("set null"),
	check("flow_runs_status_check", sql`status = ANY (ARRAY['active'::text, 'completed'::text, 'handed_off'::text, 'timed_out'::text, 'paused_by_agent'::text, 'failed'::text])`),
]);

export const flowRunEvents = pgTable("flow_run_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	flowRunId: uuid("flow_run_id").notNull(),
	eventType: text("event_type").notNull(),
	nodeKey: text("node_key"),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_flow_run_events_run_time").using("btree", table.flowRunId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("idx_flow_run_events_run_type").using("btree", table.flowRunId.asc().nullsLast().op("uuid_ops"), table.eventType.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.flowRunId],
			foreignColumns: [flowRuns.id],
			name: "flow_run_events_flow_run_id_fkey"
		}).onDelete("cascade"),
	check("flow_run_events_event_type_check", sql`event_type = ANY (ARRAY['started'::text, 'node_entered'::text, 'message_sent'::text, 'reply_received'::text, 'fallback_fired'::text, 'handoff'::text, 'timeout'::text, 'error'::text, 'completed'::text])`),
]);

export const notifications = pgTable("notifications", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	userId: uuid("user_id").notNull(),
	type: text().default('conversation_assigned').notNull(),
	conversationId: uuid("conversation_id"),
	channelId: uuid("channel_id"),
	contactId: uuid("contact_id"),
	actorUserId: uuid("actor_user_id"),
	title: text().notNull(),
	body: text(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_notifications_user_created").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_notifications_user_unread").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(read_at IS NULL)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "notifications_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "notifications_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "notifications_contact_id_fkey"
		}).onDelete("set null"),
	check("notifications_type_check", sql`type = ANY (ARRAY['conversation_assigned'::text, 'sla_alert'::text, 'mention'::text, 'broadcast_halted'::text])`),
]);

export const webhookEndpoints = pgTable("webhook_endpoints", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	url: text().notNull(),
	secret: text().notNull(),
	events: text("events").array().default(sql`'{}'::text[]`).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true, mode: 'string' }),
	failureCount: integer("failure_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("webhook_endpoints_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "webhook_endpoints_account_id_fkey"
		}).onDelete("cascade"),
]);

export const aiConfigs = pgTable("ai_configs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	provider: text().notNull(),
	model: text().notNull(),
	apiKey: text("api_key").notNull(),
	embeddingsApiKey: text("embeddings_api_key"),
	systemPrompt: text("system_prompt"),
	isActive: boolean("is_active").default(false).notNull(),
	autoReplyEnabled: boolean("auto_reply_enabled").default(false).notNull(),
	autoReplyMaxPerConversation: integer("auto_reply_max_per_conversation").default(3).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_configs_account_id_fkey"
		}).onDelete("cascade"),
	unique("ai_configs_account_id_key").on(table.accountId),
	check("ai_configs_auto_reply_max_per_conversation_check", sql`(auto_reply_max_per_conversation >= 1) AND (auto_reply_max_per_conversation <= 20)`),
	check("ai_configs_provider_check", sql`provider = ANY (ARRAY['openai'::text, 'anthropic'::text])`),
]);

export const aiKnowledgeDocuments = pgTable("ai_knowledge_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	title: text().notNull(),
	content: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ai_knowledge_documents_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_knowledge_documents_account_id_fkey"
		}).onDelete("cascade"),
]);

export const aiKnowledgeChunks = pgTable("ai_knowledge_chunks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	accountId: uuid("account_id").notNull(),
	chunkIndex: integer("chunk_index").default(0).notNull(),
	content: text().notNull(),
	fts: tsvector("fts").generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, content)`),
	embedding: vector({ dimensions: 1536 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ai_knowledge_chunks_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("ai_knowledge_chunks_document_id_idx").using("btree", table.documentId.asc().nullsLast().op("uuid_ops")),
	index("ai_knowledge_chunks_embedding_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("ai_knowledge_chunks_fts_idx").using("gin", table.fts.asc().nullsLast().op("tsvector_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [aiKnowledgeDocuments.id],
			name: "ai_knowledge_chunks_document_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_knowledge_chunks_account_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// TASKS ("Tarefas") — per-account task / reminder subsystem.
//
// Account-scoped (account_id → organization, cascade). A task has a
// free-text title + OPTIONAL free-text `type` label (no CHECK, stays
// flexible). It may link to a contact (client) and/or a deal (Kanban
// card) — both nullable, SET NULL on delete so removing a
// contact/deal doesn't destroy the task. `assigned_to` / `created_by`
// are plain uuids (member/user ids) with no FK, mirroring the loose
// user refs elsewhere. `set_updated_at` trigger keeps updated_at
// fresh (see baseline). The due-alert badge reads (overdue +
// dueToday) via getTasksOverview.
// ============================================================
export const tasks = pgTable("tasks", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	title: text().notNull(),
	description: text(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	status: text().default('open').notNull(),
	// Optional free-text label (e.g. 'ligar','cobrar','enviar_boleto',
	// 'outro'). Deliberately no CHECK so accounts can coin their own.
	type: text(),
	contactId: uuid("contact_id"),
	dealId: uuid("deal_id"),
	assignedTo: uuid("assigned_to"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_tasks_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_tasks_account_status").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_tasks_due_at").using("btree", table.dueAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_tasks_contact").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_tasks_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "tasks_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "tasks_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.dealId],
			foreignColumns: [deals.id],
			name: "tasks_deal_id_fkey"
		}).onDelete("set null"),
	check("tasks_status_check", sql`status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text])`),
]);

// ============================================================
// Scheduled messages — a single WhatsApp message queued to be sent
// into ONE conversation at a future time. Distinct from broadcasts
// (bulk, template-driven): this is a 1:1 free-text (or media) message
// an operator schedules from the inbox sidebar. A BullMQ delayed job
// (queue 'scheduled-message', jobId `sched-{id}`) fires at scheduled_at
// and the worker calls sendMessageToConversation, then flips status to
// 'sent'. Cancelling removes the job AND flips status to 'cancelled'.
// ============================================================
export const scheduledMessages = pgTable("scheduled_messages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	conversationId: uuid("conversation_id").notNull(),
	// Denormalized for display + so a deleted contact just nulls out.
	contactId: uuid("contact_id"),
	// 'text' | 'image' | 'video' | 'document' | 'audio' (matches the send
	// funnel's message types; v1 UI only creates 'text').
	messageType: text("message_type").default('text').notNull(),
	contentText: text("content_text"),
	mediaUrl: text("media_url"),
	filename: text(),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending').notNull(),
	// Set after a successful send.
	sentMessageId: uuid("sent_message_id"),
	externalMessageId: text("external_message_id"),
	lastError: text("last_error"),
	attempts: integer().default(0).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_scheduled_messages_conversation").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	index("idx_scheduled_messages_account_status").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_scheduled_messages_due").using("btree", table.scheduledAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "scheduled_messages_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "scheduled_messages_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "scheduled_messages_contact_id_fkey"
		}).onDelete("set null"),
	check("scheduled_messages_status_check", sql`status = ANY (ARRAY['pending'::text, 'sent'::text, 'cancelled'::text, 'failed'::text])`),
]);

// ============================================================
// account_settings — one row per account (organization) holding
// workspace-wide preference toggles that don't warrant their own table
// (e.g. the agent-signature toggle). Shape of `settings` is app-defined
// (see src/lib/settings/account-settings.ts).
// ============================================================
export const accountSettings = pgTable("account_settings", {
	accountId: uuid("account_id").primaryKey().notNull(),
	settings: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "account_settings_account_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// Internal team chat (Chat Interno) — Slack-style channels for the
// account's team members. Public channels are visible to everyone in the
// account; private channels only to rows in internal_channel_members.
// ============================================================
export const internalChannels = pgTable("internal_channels", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	isPrivate: boolean("is_private").default(false).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_internal_channels_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "internal_channels_account_id_fkey"
		}).onDelete("cascade"),
]);

// Monitored WhatsApp groups — opt-in ingestion. A group's messages enter the
// CRM only when it has a row here (for its channel).
export const monitoredGroups = pgTable("monitored_groups", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	groupJid: text("group_jid").notNull(),
	groupName: text("group_name"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("monitored_groups_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.groupJid.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "monitored_groups_channel_id_fkey"
		}).onDelete("cascade"),
]);

// Voice agent config per channel (IA de voz). The account-wide ai_configs is
// the TEXT agent; this is the opt-in-per-channel VOICE agent read by the media
// bridge: whether the AI answers on this number, with which prompt/voice, and
// when (always vs only on overflow).
export const voiceAgents = pgTable("voice_agents", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	enabled: boolean().default(false).notNull(),
	mode: text().default('overflow').notNull(),
	systemPrompt: text("system_prompt"),
	voiceId: text("voice_id"),
	greeting: text(),
	notifyPhone: text("notify_phone"),
	pipelineId: uuid("pipeline_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("voice_agents_channel_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "voice_agents_channel_id_fkey"
		}).onDelete("cascade"),
	check("voice_agents_mode_check", sql`mode = ANY (ARRAY['always'::text, 'overflow'::text])`),
]);

// Voice credentials per account (client-supplied). ElevenLabs (TTS) + OpenAI
// (Realtime brain) keys, one set per account, AES-256-GCM encrypted like
// ai_configs.api_key. The per-channel persona/voice lives in voice_agents.
export const voiceSettings = pgTable("voice_settings", {
	accountId: uuid("account_id").primaryKey().notNull(),
	elevenlabsApiKey: text("elevenlabs_api_key"),
	openaiApiKey: text("openai_api_key"),
	llmProvider: text("llm_provider").default('openai').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "voice_settings_account_id_fkey"
		}).onDelete("cascade"),
]);

// Group participant name registry — maps a participant's wa_key (LID user-part
// or phone digits) to the pushName we saw on their messages, so mentions inside
// group messages ("@146089705500852") render as the name ("@Guilherme Andrade").
// Best-effort cache accumulated at ingestion; keyed per account.
export const groupParticipantNames = pgTable("group_participant_names", {
	accountId: uuid("account_id").notNull(),
	waKey: text("wa_key").notNull(),
	name: text().notNull(),
	// Re-hosted (MinIO) profile photo of this participant — the group-thread
	// avatar. Backfilled best-effort from the participant's phone via the same
	// profile-picture pipeline as 1:1 contacts. Null = no photo yet / privacy /
	// only a LID is known. Kept as attempt-once-per-null.
	avatarUrl: text("avatar_url"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.accountId, table.waKey], name: "group_participant_names_pkey" }),
]);

// Conversation participants — a user granted access to a specific conversation
// (via @mention) without being its assignee. Read by the sector-privacy check.
export const conversationParticipants = pgTable("conversation_participants", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("conversation_participants_unique").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	index("conversation_participants_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "conversation_participants_conversation_id_fkey"
		}).onDelete("cascade"),
]);

export const internalChannelMembers = pgTable("internal_channel_members", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("internal_channel_members_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [internalChannels.id],
			name: "internal_channel_members_channel_id_fkey"
		}).onDelete("cascade"),
]);

export const internalMessages = pgTable("internal_messages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	senderId: uuid("sender_id").notNull(),
	content: text().notNull(),
	// Optional attachment (migration 0033). media_type: image|video|audio|document.
	mediaUrl: text("media_url"),
	mediaType: text("media_type"),
	mediaName: text("media_name"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_internal_messages_channel").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [internalChannels.id],
			name: "internal_messages_channel_id_fkey"
		}).onDelete("cascade"),
]);

// Presence (Fase 3): one row per user, online/away + last heartbeat.
// "offline" is derived client-side from staleness (see lib/presence.ts).
export const memberPresence = pgTable("member_presence", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	userId: uuid("user_id").notNull(),
	status: text().default('online').notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("member_presence_user_id_key").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_member_presence_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	check("member_presence_status_check", sql`status = ANY (ARRAY['online'::text, 'away'::text, 'offline'::text])`),
]);

// Per-user read state for internal chat channels — drives the unread badge.
export const internalChannelReads = pgTable("internal_channel_reads", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	userId: uuid("user_id").notNull(),
	lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("internal_channel_reads_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [internalChannels.id],
			name: "internal_channel_reads_channel_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// Sectors (departments) — organize conversations by team (Vendas,
// Financeiro, Suporte…). Drive both routing and PRIVACY: a non-admin agent
// only sees conversations whose sector they belong to (plus the general,
// null-sector queue). Admins/owner see everything.
// ============================================================
export const sectors = pgTable("sectors", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	color: text().default('#6d4bd8').notNull(),
	// Phase 2 routing: if the first inbound message text contains any of
	// these keywords (case/accent-insensitive), the conversation is routed
	// to this sector — this beats the channel's default sector.
	keywords: text().array().default(sql`ARRAY[]::text[]`).notNull(),
	// When true, a conversation routed to this sector is auto-assigned to the
	// least-loaded member of the sector. When false, it lands unassigned in
	// the sector's queue for someone to pick up.
	autoAssign: boolean("auto_assign").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_sectors_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "sectors_account_id_fkey"
		}).onDelete("cascade"),
]);

export const sectorMembers = pgTable("sector_members", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	sectorId: uuid("sector_id").notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("sector_members_unique").using("btree", table.sectorId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_sector_members_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.sectorId],
			foreignColumns: [sectors.id],
			name: "sector_members_sector_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// Quick replies (respostas rápidas) — canned messages an agent inserts in
// the composer by shortcut. Account-shared; managed by admins, used by all.
// ============================================================
export const quickReplies = pgTable("quick_replies", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	shortcut: text().notNull(),
	content: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_quick_replies_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("quick_replies_account_shortcut").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), sql`lower(shortcut)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "quick_replies_account_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// CSAT (pesquisa de satisfação) — a 1–5 score the customer sends after a
// conversation is closed. conversations.csat_pending_at flags an awaited reply.
// ============================================================
export const csatResponses = pgTable("csat_responses", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	conversationId: uuid("conversation_id"),
	contactId: uuid("contact_id"),
	agentId: uuid("agent_id"),
	score: integer().notNull(),
	comment: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_csat_account_created").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	check("csat_responses_score_check", sql`score >= 1 AND score <= 5`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "csat_responses_account_id_fkey"
		}).onDelete("cascade"),
]);
