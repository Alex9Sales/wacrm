-- Follow-up por ETAPA (gatilho de entrada em etapa): marca quando o último
-- follow-up de etapa foi disparado pra este deal. Dispara de novo só quando o
-- card ENTRA numa etapa nova (stage_changed_at > stage_follow_up_at) — assim é
-- 1 follow-up por entrada de etapa, não a cada tick.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_follow_up_at timestamptz;
