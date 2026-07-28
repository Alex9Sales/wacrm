-- Private conversations: only the assigned agent, admins, supervisors and
-- explicit participants can see them. Everyone else (agents it isn't assigned
-- to, the general queue) loses visibility while is_private = true.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "is_private" boolean NOT NULL DEFAULT false;
