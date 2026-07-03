import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, messageTemplates, whatsappConfig } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

// Full row projected with snake_case aliases so the JSON response keeps
// the exact shape the dashboard consumed from PostgREST.
const TEMPLATE_ROW_SELECT = {
  id: messageTemplates.id,
  user_id: messageTemplates.userId,
  account_id: messageTemplates.accountId,
  name: messageTemplates.name,
  category: messageTemplates.category,
  language: messageTemplates.language,
  header_type: messageTemplates.headerType,
  header_content: messageTemplates.headerContent,
  body_text: messageTemplates.bodyText,
  footer_text: messageTemplates.footerText,
  buttons: messageTemplates.buttons,
  status: messageTemplates.status,
  sample_values: messageTemplates.sampleValues,
  meta_template_id: messageTemplates.metaTemplateId,
  rejection_reason: messageTemplates.rejectionReason,
  quality_score: messageTemplates.qualityScore,
  header_handle: messageTemplates.headerHandle,
  header_media_url: messageTemplates.headerMediaUrl,
  submission_error: messageTemplates.submissionError,
  last_submitted_at: messageTemplates.lastSubmittedAt,
  created_at: messageTemplates.createdAt,
  updated_at: messageTemplates.updatedAt,
}

/**
 * Shared upsert payload builder — both the Meta-failure path and the
 * Meta-success path write nearly identical rows; dropping the shared
 * fields here means adding a column later only touches one spot.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string
    metaTemplateId: string | null
    submissionError: string | null
  },
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    accountId,
    // Original author — kept as audit only. The unique index is
    // still on (user_id, name, language) — see the upsert helper
    // for the cross-teammate dedup follow-up.
    userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    headerType: payload.header_type ?? null,
    headerContent: payload.header_content ?? null,
    headerMediaUrl: payload.header_media_url ?? null,
    headerHandle: payload.header_handle ?? null,
    bodyText: payload.body_text,
    footerText: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sampleValues: payload.sample_values ?? null,
    status: extras.status,
    metaTemplateId: extras.metaTemplateId,
    submissionError: extras.submissionError,
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejectionReason: extras.submissionError ? null : null,
    lastSubmittedAt: new Date().toISOString(),
  }
}

async function upsertTemplateRow(row: ReturnType<typeof buildUpsertRow>) {
  // TODO(account-sharing): conflict target is still scoped to
  // user_id. Once a follow-up migration drops the legacy unique
  // index on (user_id, name, language) and adds (account_id,
  // name, language), switch the conflict target here so two
  // teammates can't shadow each other's same-named template.
  const { accountId: _accountId, userId: _userId, ...updatable } = row
  void _accountId
  void _userId
  return firstOrNull(
    await db
      .insert(messageTemplates)
      .values(row)
      .onConflictDoUpdate({
        target: [
          messageTemplates.userId,
          messageTemplates.name,
          messageTemplates.language,
        ],
        set: updatable,
      })
      .returning(TEMPLATE_ROW_SELECT)
  )
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → fetch whatsapp_config → validate → (DRY_RUN short-circuit) →
 * POST to Meta → upsert local row by (user_id, name, language) with
 * status, meta_template_id, sample_values, last_submitted_at.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true, we skip the network call and
 * insert a row with a synthetic `dry-run-<uuid>` meta_template_id so
 * CI / local dev can exercise the full UI without a real Meta App.
 *
 * On the Meta side this is a one-way trip — a row can only be
 * submitted; editing or deleting requires hsm_id and lives in PR 4.
 */
export async function POST(request: Request) {
  try {
    let ctx: AccountContext
    try {
      ctx = await getCurrentAccount()
    } catch (err) {
      return toErrorResponse(err)
    }
    const accountId = ctx.accountId

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'

    let metaTemplateId: string
    let metaStatus: string

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`
      metaStatus = 'PENDING'
    } else {
      const config = firstOrNull(
        await db
          .select()
          .from(whatsappConfig)
          .where(eq(whatsappConfig.accountId, accountId))
          .limit(1)
      )
      if (!config) {
        return NextResponse.json(
          {
            error:
              'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
          },
          { status: 400 },
        )
      }
      if (!config.wabaId) {
        return NextResponse.json(
          {
            error:
              'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
          },
          { status: 400 },
        )
      }

      const accessToken = decrypt(config.accessToken)

      // Image headers need a Resumable-Upload handle (Meta rejects a
      // plain URL at creation). Derive it from header_media_url before
      // building the payload. Surfaces a 400 with an actionable message
      // (missing META_APP_ID, unreachable URL, wrong type/size).
      try {
        await ensureImageHeaderHandle(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Header image upload failed.' },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        const meta = await submitMessageTemplate({
          wabaId: config.wabaId,
          accessToken,
          payload: metaPayload,
        })
        metaTemplateId = meta.id
        metaStatus = meta.status
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed.'
        // Persist the failure so the user can retry; row stays DRAFT
        // until they fix and re-submit. Best-effort — a local write
        // failure must not mask the Meta error we're about to return.
        try {
          await upsertTemplateRow(
            buildUpsertRow(accountId, ctx.userId, payload, {
              status: 'DRAFT',
              metaTemplateId: null,
              submissionError: message,
            }),
          )
        } catch (persistErr) {
          console.error(
            'Failed to persist template submission error:',
            persistErr,
          )
        }
        const isRateLimit = /\b429\b/.test(message)
        return NextResponse.json(
          {
            error: isRateLimit
              ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        )
      }
    }

    let row
    try {
      row = await upsertTemplateRow(
        buildUpsertRow(accountId, ctx.userId, payload, {
          status: normalizeStatus(metaStatus),
          metaTemplateId,
          submissionError: null,
        }),
      )
    } catch (upsertErr) {
      // The submit succeeded on Meta's side but we failed to persist
      // locally. That's a data-drift state — surface the meta_template_id
      // so the user can recover via "Sync from Meta".
      const message =
        upsertErr instanceof Error ? upsertErr.message : String(upsertErr)
      return NextResponse.json(
        {
          error: `Submitted to Meta but failed to save locally: ${message}. Run "Sync from Meta" to recover.`,
          meta_template_id: metaTemplateId,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: dryRun,
    })
  } catch (error) {
    console.error('Error submitting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to submit template.',
      },
      { status: 500 },
    )
  }
}
