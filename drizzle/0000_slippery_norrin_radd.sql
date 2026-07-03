-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."account_role_enum" AS ENUM('owner', 'admin', 'agent', 'viewer');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_default_currency_format" CHECK (default_currency ~ '^[A-Z]{3}$'::text)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"account_role" "account_role_enum" NOT NULL,
	"full_name" text NOT NULL,
	"email" text NOT NULL,
	"avatar_url" text,
	"role" text DEFAULT 'user',
	"beta_features" text[] DEFAULT '{"RAY"}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "profiles_user_id_key" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"phone_normalized" text GENERATED ALWAYS AS (regexp_replace(phone, '\D'::text, ''::text, 'g'::text)) STORED,
	"name" text,
	"email" text,
	"company" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "contact_tags" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"contact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contact_tags_contact_id_tag_id_key" UNIQUE("contact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "custom_fields" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"field_options" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "contact_custom_values" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"contact_id" uuid NOT NULL,
	"custom_field_id" uuid NOT NULL,
	"value" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "contact_custom_values_contact_id_custom_field_id_key" UNIQUE("contact_id","custom_field_id")
);
--> statement-breakpoint
CREATE TABLE "contact_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"contact_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"note_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_agent_id" uuid,
	"last_message_text" text,
	"last_message_at" timestamp with time zone,
	"unread_count" integer DEFAULT 0,
	"ai_autoreply_disabled" boolean DEFAULT false NOT NULL,
	"ai_reply_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "conversations_status_check" CHECK (status = ANY (ARRAY['open'::text, 'pending'::text, 'closed'::text]))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_type" text NOT NULL,
	"sender_id" uuid,
	"content_type" text DEFAULT 'text' NOT NULL,
	"content_text" text,
	"media_url" text,
	"template_name" text,
	"message_id" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"reply_to_message_id" uuid,
	"interactive_reply_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "messages_sender_type_check" CHECK (sender_type = ANY (ARRAY['customer'::text, 'agent'::text, 'bot'::text])),
	CONSTRAINT "messages_status_check" CHECK (status = ANY (ARRAY['sending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])),
	CONSTRAINT "messages_content_type_check" CHECK (content_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text, 'audio'::text, 'video'::text, 'location'::text, 'template'::text, 'interactive'::text]))
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_actor_type_actor_id_key" UNIQUE("message_id","actor_type","actor_id"),
	CONSTRAINT "message_reactions_actor_type_check" CHECK (actor_type = ANY (ARRAY['customer'::text, 'agent'::text]))
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "whatsapp_config" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text,
	"access_token" text NOT NULL,
	"verify_token" text,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"connected_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"subscribed_apps_at" timestamp with time zone,
	"last_registration_error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "whatsapp_config_account_id_key" UNIQUE("account_id"),
	CONSTRAINT "whatsapp_config_phone_number_id_key" UNIQUE("phone_number_id"),
	CONSTRAINT "whatsapp_config_status_check" CHECK (status = ANY (ARRAY['connected'::text, 'disconnected'::text]))
);
--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Marketing' NOT NULL,
	"language" text DEFAULT 'en_US',
	"header_type" text,
	"header_content" text,
	"body_text" text NOT NULL,
	"footer_text" text,
	"buttons" jsonb,
	"status" text DEFAULT 'DRAFT',
	"sample_values" jsonb,
	"meta_template_id" text,
	"rejection_reason" text,
	"quality_score" text,
	"header_handle" text,
	"header_media_url" text,
	"submission_error" text,
	"last_submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "message_templates_category_check" CHECK (category = ANY (ARRAY['Marketing'::text, 'Utility'::text, 'Authentication'::text])),
	CONSTRAINT "message_templates_header_type_check" CHECK (header_type = ANY (ARRAY['text'::text, 'image'::text, 'video'::text, 'document'::text])),
	CONSTRAINT "message_templates_status_meta_check" CHECK (status = ANY (ARRAY['DRAFT'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'PAUSED'::text, 'DISABLED'::text, 'IN_APPEAL'::text, 'PENDING_DELETION'::text])),
	CONSTRAINT "message_templates_quality_score_check" CHECK ((quality_score IS NULL) OR (quality_score = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text]))),
	CONSTRAINT "message_templates_buttons_shape_check" CHECK ((buttons IS NULL) OR ((jsonb_typeof(buttons) = 'array'::text) AND (jsonb_array_length(buttons) <= 10)))
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"color" text DEFAULT '#3b82f6' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"assigned_to" uuid,
	"title" text NOT NULL,
	"value" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD',
	"notes" text,
	"expected_close_date" date,
	"status" text DEFAULT 'open',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "deals_status_check" CHECK (status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text]))
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"template_name" text NOT NULL,
	"template_language" text DEFAULT 'en_US' NOT NULL,
	"template_variables" jsonb,
	"audience_filter" jsonb,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_recipients" integer DEFAULT 0,
	"sent_count" integer DEFAULT 0,
	"delivered_count" integer DEFAULT 0,
	"read_count" integer DEFAULT 0,
	"replied_count" integer DEFAULT 0,
	"failed_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "broadcasts_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "broadcast_recipients" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"contact_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"whatsapp_message_id" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "broadcast_recipients_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'replied'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"automation_id" uuid NOT NULL,
	"parent_step_id" uuid,
	"branch" text,
	"step_type" text NOT NULL,
	"step_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_steps_branch_check" CHECK (branch = ANY (ARRAY['yes'::text, 'no'::text]))
);
--> statement-breakpoint
CREATE TABLE "automation_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"trigger_event" text NOT NULL,
	"steps_executed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_logs_status_check" CHECK (status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "automation_pending_executions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"automation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"log_id" uuid,
	"parent_step_id" uuid,
	"branch" text,
	"next_step_position" integer NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_pending_executions_branch_check" CHECK (branch = ANY (ARRAY['yes'::text, 'no'::text])),
	CONSTRAINT "automation_pending_executions_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entry_node_id" text,
	"fallback_policy" jsonb DEFAULT '{"on_exhaust":"handoff","max_reprompts":2,"on_timeout_hours":24,"on_unknown_reply":"reprompt"}'::jsonb NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"last_executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flows_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])),
	CONSTRAINT "flows_trigger_type_check" CHECK (trigger_type = ANY (ARRAY['keyword'::text, 'first_inbound_message'::text, 'manual'::text]))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{""}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_key" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "flow_nodes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"flow_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position_x" integer DEFAULT 0 NOT NULL,
	"position_y" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_nodes_flow_id_node_key_key" UNIQUE("flow_id","node_key"),
	CONSTRAINT "flow_nodes_node_type_check" CHECK (node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text]))
);
--> statement-breakpoint
CREATE TABLE "flow_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"flow_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"conversation_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"current_node_key" text,
	"last_prompt_message_id" uuid,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reprompt_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_advanced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "flow_runs_status_check" CHECK (status = ANY (ARRAY['active'::text, 'completed'::text, 'handed_off'::text, 'timed_out'::text, 'paused_by_agent'::text, 'failed'::text]))
);
--> statement-breakpoint
CREATE TABLE "flow_run_events" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"flow_run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"node_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_run_events_event_type_check" CHECK (event_type = ANY (ARRAY['started'::text, 'node_entered'::text, 'message_sent'::text, 'reply_received'::text, 'fallback_fired'::text, 'handoff'::text, 'timeout'::text, 'error'::text, 'completed'::text]))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text DEFAULT 'conversation_assigned' NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"actor_user_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_check" CHECK (type = 'conversation_assigned'::text)
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT '{""}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"api_key" text NOT NULL,
	"embeddings_api_key" text,
	"system_prompt" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"auto_reply_enabled" boolean DEFAULT false NOT NULL,
	"auto_reply_max_per_conversation" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_configs_account_id_key" UNIQUE("account_id"),
	CONSTRAINT "ai_configs_auto_reply_max_per_conversation_check" CHECK ((auto_reply_max_per_conversation >= 1) AND (auto_reply_max_per_conversation <= 20)),
	CONSTRAINT "ai_configs_provider_check" CHECK (provider = ANY (ARRAY['openai'::text, 'anthropic'::text]))
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"content" text NOT NULL,
	"fts" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "public"."custom_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "public"."broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "public"."automation_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "public"."automation_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "public"."automation_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_last_prompt_message_id_fkey" FOREIGN KEY ("last_prompt_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_run_events" ADD CONSTRAINT "flow_run_events_flow_run_id_fkey" FOREIGN KEY ("flow_run_id") REFERENCES "public"."flow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."ai_knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_accounts_one_per_owner" ON "accounts" USING btree ("owner_user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_profiles_account_role" ON "profiles" USING btree ("account_id" uuid_ops,"account_role" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_contacts_account" ON "contacts" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_contacts_account_phone_normalized" ON "contacts" USING btree ("account_id" text_ops,"phone_normalized" text_ops) WHERE (phone_normalized <> ''::text);--> statement-breakpoint
CREATE INDEX "idx_contacts_phone" ON "contacts" USING btree ("phone" text_ops);--> statement-breakpoint
CREATE INDEX "idx_contacts_user_id" ON "contacts" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_tags_account" ON "tags" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_contact_tags_contact" ON "contact_tags" USING btree ("contact_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_contact_tags_tag" ON "contact_tags" USING btree ("tag_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_custom_fields_account" ON "custom_fields" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_contact_notes_account" ON "contact_notes" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_conversations_account" ON "conversations" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_conversations_contact_id" ON "conversations" USING btree ("contact_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_conversations_user_id" ON "conversations" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_conversation" ON "messages" USING btree ("conversation_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_message_id" ON "messages" USING btree ("message_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_messages_reply_to" ON "messages" USING btree ("reply_to_message_id" uuid_ops) WHERE (reply_to_message_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_message_reactions_conversation" ON "message_reactions" USING btree ("conversation_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_reactions_message" ON "message_reactions" USING btree ("message_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_pipelines_account" ON "pipelines" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_whatsapp_config_account" ON "whatsapp_config" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_whatsapp_config_registered_at" ON "whatsapp_config" USING btree ("registered_at" timestamptz_ops) WHERE (registered_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_message_templates_account" ON "message_templates" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_message_templates_meta_template_id" ON "message_templates" USING btree ("meta_template_id" text_ops) WHERE (meta_template_id IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_user_name_language_key" ON "message_templates" USING btree ("user_id" uuid_ops,"name" uuid_ops,"language" text_ops);--> statement-breakpoint
CREATE INDEX "idx_pipeline_stages_pipeline" ON "pipeline_stages" USING btree ("pipeline_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deals_account" ON "deals" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deals_assigned_to" ON "deals" USING btree ("assigned_to" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deals_pipeline" ON "deals" USING btree ("pipeline_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_deals_stage" ON "deals" USING btree ("stage_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_broadcasts_account" ON "broadcasts" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_broadcast_recipients_broadcast" ON "broadcast_recipients" USING btree ("broadcast_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_broadcast_recipients_broadcast_status" ON "broadcast_recipients" USING btree ("broadcast_id" text_ops,"status" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_broadcast_recipients_wamid" ON "broadcast_recipients" USING btree ("whatsapp_message_id" text_ops) WHERE (whatsapp_message_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_automations_account" ON "automations" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_automations_account_active_trigger" ON "automations" USING btree ("account_id" text_ops,"trigger_type" text_ops) WHERE (is_active = true);--> statement-breakpoint
CREATE INDEX "idx_automations_active_trigger" ON "automations" USING btree ("trigger_type" text_ops) WHERE (is_active = true);--> statement-breakpoint
CREATE INDEX "idx_automations_user_id" ON "automations" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_steps_automation_id" ON "automation_steps" USING btree ("automation_id" int4_ops,"position" int4_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_steps_parent" ON "automation_steps" USING btree ("parent_step_id" uuid_ops) WHERE (parent_step_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "idx_automation_logs_account" ON "automation_logs" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_logs_automation" ON "automation_logs" USING btree ("automation_id" uuid_ops,"created_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_logs_user" ON "automation_logs" USING btree ("user_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_pending_account" ON "automation_pending_executions" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_automation_pending_due" ON "automation_pending_executions" USING btree ("run_at" timestamptz_ops) WHERE (status = 'pending'::text);--> statement-breakpoint
CREATE INDEX "idx_flows_account" ON "flows" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_flows_account_active" ON "flows" USING btree ("account_id" uuid_ops) WHERE (status = 'active'::text);--> statement-breakpoint
CREATE INDEX "idx_flows_active_trigger" ON "flows" USING btree ("user_id" uuid_ops,"trigger_type" uuid_ops) WHERE (status = 'active'::text);--> statement-breakpoint
CREATE INDEX "api_keys_account_id_idx" ON "api_keys" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "api_keys_key_hash_idx" ON "api_keys" USING btree ("key_hash" text_ops);--> statement-breakpoint
CREATE INDEX "idx_flow_nodes_flow" ON "flow_nodes" USING btree ("flow_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_flow_runs_account" ON "flow_runs" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_flow_runs_active_advanced" ON "flow_runs" USING btree ("last_advanced_at" timestamptz_ops) WHERE (status = 'active'::text);--> statement-breakpoint
CREATE INDEX "idx_flow_runs_flow_started" ON "flow_runs" USING btree ("flow_id" uuid_ops,"started_at" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_active_run_per_contact" ON "flow_runs" USING btree ("account_id" uuid_ops,"contact_id" uuid_ops) WHERE (status = 'active'::text);--> statement-breakpoint
CREATE INDEX "idx_flow_run_events_run_time" ON "flow_run_events" USING btree ("flow_run_id" timestamptz_ops,"created_at" uuid_ops);--> statement-breakpoint
CREATE INDEX "idx_flow_run_events_run_type" ON "flow_run_events" USING btree ("flow_run_id" uuid_ops,"event_type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_notifications_user_created" ON "notifications" USING btree ("user_id" timestamptz_ops,"created_at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread" ON "notifications" USING btree ("user_id" uuid_ops) WHERE (read_at IS NULL);--> statement-breakpoint
CREATE INDEX "webhook_endpoints_account_id_idx" ON "webhook_endpoints" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ai_knowledge_documents_account_id_idx" ON "ai_knowledge_documents" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_account_id_idx" ON "ai_knowledge_chunks" USING btree ("account_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_document_id_idx" ON "ai_knowledge_chunks" USING btree ("document_id" uuid_ops);--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_embedding_idx" ON "ai_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "ai_knowledge_chunks_fts_idx" ON "ai_knowledge_chunks" USING gin ("fts" tsvector_ops);
*/