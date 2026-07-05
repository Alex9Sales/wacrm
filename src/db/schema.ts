import { pgTable, uniqueIndex, check, uuid, text, timestamp, index, foreignKey, unique, jsonb, integer, boolean, numeric, date, vector, customType } from "drizzle-orm/pg-core"
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
	avatarUrl: text("avatar_url"),
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
	lastMessageText: text("last_message_text"),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }),
	unreadCount: integer("unread_count").default(0),
	aiAutoreplyDisabled: boolean("ai_autoreply_disabled").default(false).notNull(),
	aiReplyCount: integer("ai_reply_count").default(0).notNull(),
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
	templateName: text("template_name").notNull(),
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
	check("notifications_type_check", sql`type = 'conversation_assigned'::text`),
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
