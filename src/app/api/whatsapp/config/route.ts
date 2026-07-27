import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import {
  getCurrentAccount,
  UnauthorizedError,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import {
  createChannel,
  loadMetaChannelByAccount,
  loadMetaChannelByPhoneNumberId,
  encryptCredentials,
} from '@/lib/channels/channels'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved Meta channel is healthy. Returns 200 in all
 * non-auth cases so the UI can render an appropriate message rather
 * than show a 500.
 *
 * Phase 4: reads the account's Meta channel (credentials already
 * decrypted on the ctx) and pings Meta to verify the phone number.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
 */
export async function GET() {
  try {
    // Session + account. The GET handler wants shaped 200s for every
    // non-auth failure mode — so a missing/orphaned profile maps to the
    // `no_account` payload instead of a thrown 403.
    let ctx: AccountContext
    try {
      ctx = await getCurrentAccount()
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }
    const accountId = ctx.accountId

    // Load the account's Meta channel. Its credentials arrive already
    // decrypted on the ctx (channels.ts owns the decrypt round-trip).
    let channel
    try {
      channel = await loadMetaChannelByAccount(accountId)
    } catch (configError) {
      // Decryption of the stored credentials failed — the ENCRYPTION_KEY
      // changed or differs across environments. Surface the recoverable
      // state so the UI can offer a reset.
      console.error('[whatsapp/config GET] Failed to load Meta channel:', configError)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 },
      )
    }

    if (!channel) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 },
      )
    }

    const phoneNumberId = channel.providerMeta.phone_number_id as
      | string
      | undefined
    const accessToken = channel.credentials.accessToken as string | undefined

    if (!phoneNumberId || !accessToken) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message:
            'The Meta channel is missing a phone number id or access token. Re-save the configuration.',
        },
        { status: 200 },
      )
    }

    // Validate credentials against Meta
    try {
      const phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken })
      return NextResponse.json({ connected: true, phone_info: phoneInfo })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 },
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the account's Meta channel. Verifies credentials
 * with Meta first, then stores them (encrypted) on the channel.
 *
 * Phase 4: writes a `provider = 'meta'` channels row —
 *   credentials  = { accessToken, verifyToken }
 *   providerMeta = { phone_number_id, waba_id, registered_at, subscribed_apps_at, last_registration_error }
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

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token, app_secret, pin } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 },
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 },
        )
      }
    }

    // Reject if another account has already claimed this phone_number_id.
    // The `channels_meta_pnid` partial unique index guarantees at most one
    // Meta channel per phone_number_id across the whole instance, so a
    // cross-account collision would otherwise make inbound routing
    // ambiguous. Resolve the existing owner up-front and reject early.
    let claimed
    try {
      claimed = await loadMetaChannelByPhoneNumberId(phone_number_id)
    } catch (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 },
      )
    }

    if (claimed && claimed.accountId !== accountId) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 },
      )
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 },
      )
    }

    // Look up any pre-existing Meta channel for this account so we know
    // whether this number is already registered with Meta — if so we can
    // skip /register when the user didn't provide a PIN this time around.
    const existing = await loadMetaChannelByAccount(accountId)
    const existingMeta = (existing?.providerMeta ?? {}) as Record<string, unknown>
    const existingRegisteredAt =
      (existingMeta.registered_at as string | null | undefined) ?? null

    const sameNumber =
      existingMeta.phone_number_id === phone_number_id &&
      existingRegisteredAt != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existingRegisteredAt
    let registrationError: string | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false

    const needsRegistration =
      !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). Treat it as best-effort: skip it, save the
        // (already Meta-verified) credentials as connected, and leave
        // registered_at null.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id.
    let subscribedAppsAt: string | null =
      (existingMeta.subscribed_apps_at as string | null | undefined) ?? null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
      }
    }

    // Build the channel payload. Secrets go in `credentials` (encrypted
    // by createChannel / encryptCredentials); non-secret routing +
    // registration progress lives in `provider_meta`.
    const credentials = {
      accessToken: access_token,
      verifyToken: verify_token || null,
      // Per-channel Meta App Secret (multi-tenant): when the client runs their
      // OWN Meta App, their webhooks are HMAC-signed with THIS secret, and the
      // webhook route verifies against it (falls back to global META_APP_SECRET
      // when null — e.g. numbers on the instance's own app). The UI field loads
      // blank for security, so a blank value here means "keep what's stored" —
      // otherwise a routine token rotation would silently wipe the secret and
      // break every inbound webhook for the channel.
      appSecret:
        typeof app_secret === 'string' && app_secret.trim()
          ? app_secret.trim()
          : ((claimed?.credentials?.appSecret as string | undefined) ?? null),
    }
    const providerMeta = {
      phone_number_id,
      waba_id: waba_id || null,
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt,
      last_registration_error: registrationError,
      connected_at: registrationError ? null : new Date().toISOString(),
    }
    const status = registrationError ? 'disconnected' : 'connected'

    try {
      if (existing) {
        await db
          .update(channels)
          .set({
            status,
            phoneNumber: phoneInfo?.display_phone_number ?? existing.phoneNumber,
            credentials: encryptCredentials(credentials),
            providerMeta,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(channels.id, existing.id))
      } else {
        await createChannel(accountId, {
          provider: 'meta',
          name: 'WhatsApp (Meta)',
          status,
          phoneNumber: phoneInfo?.display_phone_number ?? null,
          credentials,
          providerMeta,
        })
      }
    } catch (writeError) {
      console.error('Error saving Meta channel:', writeError)
      return NextResponse.json(
        { error: 'Failed to save configuration' },
        { status: 500 },
      )
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the account's Meta channel. Used by the "Reset Configuration"
 * button to recover from a corrupted encrypted token (mismatched
 * ENCRYPTION_KEY across environments).
 */
export async function DELETE() {
  try {
    let ctx: AccountContext
    try {
      ctx = await getCurrentAccount()
    } catch (err) {
      return toErrorResponse(err)
    }

    try {
      await db
        .delete(channels)
        .where(
          and(
            eq(channels.accountId, ctx.accountId),
            eq(channels.provider, 'meta'),
          ),
        )
    } catch (deleteError) {
      console.error('Error deleting Meta channel:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
