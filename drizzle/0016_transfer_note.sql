-- Transferência entre setores: nota de handoff mostrada ao novo atendente.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "transfer_note" text;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "transfer_note_at" timestamp with time zone;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "transfer_note_by" uuid;
