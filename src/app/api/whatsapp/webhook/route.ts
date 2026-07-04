// ============================================================
// Back-compat alias for the Meta webhook (Phase 4, wave 3A).
//
// The canonical Meta webhook now lives at /api/webhooks/meta. This path
// (/api/whatsapp/webhook) is the URL Meta was originally configured with,
// so we keep it working by re-exporting the meta route's GET (verify
// challenge) + POST (message/status ingestion) handlers verbatim. New
// integrations should point Meta at /api/webhooks/meta; existing ones keep
// working here with no change.
// ============================================================

export { GET, POST, maxDuration } from '@/app/api/webhooks/meta/route'
