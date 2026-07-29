-- Internal team chat: attachments (image / audio / document / video). The
-- media lives in the shared chat-media bucket; `content` stays as the optional
-- caption / text body. All nullable so text-only messages are unaffected.
ALTER TABLE "internal_messages"
  ADD COLUMN IF NOT EXISTS "media_url" text,
  ADD COLUMN IF NOT EXISTS "media_type" text,
  ADD COLUMN IF NOT EXISTS "media_name" text;
