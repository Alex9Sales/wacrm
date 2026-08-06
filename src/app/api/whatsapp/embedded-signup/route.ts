// ============================================================
// POST /api/whatsapp/embedded-signup
//
// Onboard a client's OFFICIAL WhatsApp number via Meta Embedded Signup
// (Tech Provider model). The browser runs FB.login with our app's ES config
// and hands us:
//   - `code`             — exchangeable for a business access token
//   - `phone_number_id`  — the onboarded number (from the ES session-info msg)
//   - `waba_id`          — the client's WhatsApp Business Account
//
// We then, server-side:
//   1. exchange the code for a business token (app_id + app_secret);
//   2. verify the phone number (display name);
//   3. subscribe OUR app to the client's WABA (`/{waba_id}/subscribed_apps`) —
//      this is what makes their inbound webhooks flow to our single callback,
//      which then routes by phone_number_id (loadMetaChannelByPhoneNumberId);
//   4. create/refresh the Meta channel for the caller's account, keyed on the
//      phone_number_id (one channel per number, instance-wide).
//
// The number is NOT double-billed to us: as a Tech Provider, the client adds
// their own payment method during the ES flow. We never see the app secret in
// the browser (only this server route uses it).
//
// ⚠️ For EXTERNAL clients in LIVE mode this requires the app's WhatsApp
// permissions approved (App Review). In dev mode it works for admins/testers.
// ============================================================

import { randomInt } from 'node:crypto'

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import {
  createChannel,
  encryptCredentials,
  loadMetaChannelByPhoneNumberId,
} from '@/lib/channels/channels'
import {
  exchangeEmbeddedSignupCode,
  verifyPhoneNumber,
  subscribeWabaToApp,
  registerPhoneNumber,
} from '@/lib/whatsapp/meta-api'

export async function POST(request: Request) {
  let ctx: AccountContext
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as {
    code?: string
    phone_number_id?: string
    waba_id?: string
    name?: string
  } | null

  const code = typeof body?.code === 'string' ? body.code : ''
  const phoneNumberId =
    typeof body?.phone_number_id === 'string' ? body.phone_number_id : ''
  const wabaId = typeof body?.waba_id === 'string' && body.waba_id ? body.waba_id : null

  // Observability (no secrets): confirms the browser POST actually reached us
  // and which ids the ES session-info message carried.
  console.log(
    `[embedded-signup] received account=${ctx.accountId} hasCode=${Boolean(
      code,
    )} phone_number_id=${phoneNumberId || '(missing)'} waba_id=${wabaId || '(missing)'}`,
  )

  if (!code || !phoneNumberId) {
    return NextResponse.json(
      { error: 'code e phone_number_id são obrigatórios' },
      { status: 400 },
    )
  }

  // One Meta channel per phone_number_id across the whole instance. If another
  // account already owns this number, refuse (don't hijack their inbound).
  const claimed = await loadMetaChannelByPhoneNumberId(phoneNumberId).catch(
    () => null,
  )
  if (claimed && claimed.accountId !== ctx.accountId) {
    return NextResponse.json(
      { error: 'Este número já está conectado em outra conta.' },
      { status: 409 },
    )
  }

  // 1) code -> business access token (needs META_APP_ID + META_APP_SECRET).
  let accessToken: string
  try {
    accessToken = (await exchangeEmbeddedSignupCode({ code })).accessToken
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Falha ao trocar o código'
    console.error('[embedded-signup] token exchange failed:', message)
    return NextResponse.json({ error: message }, { status: 502 })
  }

  // 2) verify the phone number (display name / quality).
  let phoneInfo
  try {
    phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[embedded-signup] verifyPhoneNumber failed:', message)
    return NextResponse.json(
      { error: `A Meta rejeitou o número: ${message}` },
      { status: 502 },
    )
  }

  // 3) subscribe OUR app to the client's WABA — this is what actually makes
  //    their inbound webhooks reach us. Idempotent; non-fatal if it hiccups.
  let subscribedAppsAt: string | null = null
  if (wabaId) {
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      console.warn(
        '[embedded-signup] subscribed_apps failed (non-fatal):',
        err instanceof Error ? err.message : err,
      )
    }
  }

  // 4) register the number for our app's webhook. Subscribing the WABA is not
  //    enough on its own — /register binds THIS number to our app so inbound
  //    events actually reach us. ES-verified numbers are usually already
  //    registered (idempotent: "already registered" counts as success), and
  //    when 2FA isn't set yet, /register sets the PIN we generate. Best-effort:
  //    a number still under Meta review ("Em análise") may reject this — the
  //    channel is created either way and the number registers once approved.
  const regPin = String(randomInt(100000, 1000000))
  let registeredAt: string | null = null
  let registrationError: string | null = null
  try {
    await registerPhoneNumber({ phoneNumberId, accessToken, pin: regPin })
    registeredAt = new Date().toISOString()
  } catch (err) {
    registrationError = err instanceof Error ? err.message : String(err)
    console.warn(
      '[embedded-signup] register failed (non-fatal):',
      registrationError,
    )
  }

  // Secrets encrypted in `credentials`; routing/progress in `provider_meta`.
  // verifyToken/appSecret stay null: ES numbers ride OUR app's webhook config
  // (the webhook route falls back to the global META_APP_SECRET for them).
  // `regPin` is the 2FA PIN we set on /register, kept for re-registration.
  const credentials = { accessToken, verifyToken: null, appSecret: null, regPin }
  const providerMeta = {
    phone_number_id: phoneNumberId,
    waba_id: wabaId,
    subscribed_apps_at: subscribedAppsAt,
    registered_at: registeredAt,
    last_registration_error: registrationError,
    connected_at: new Date().toISOString(),
    onboarded_via: 'embedded_signup',
  }

  try {
    if (claimed) {
      await db
        .update(channels)
        .set({
          status: 'connected',
          phoneNumber: phoneInfo?.display_phone_number ?? null,
          credentials: encryptCredentials(credentials),
          providerMeta,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(channels.id, claimed.id))
    } else {
      await createChannel(ctx.accountId, {
        provider: 'meta',
        name:
          body?.name?.trim() ||
          phoneInfo?.verified_name ||
          phoneInfo?.display_phone_number ||
          'WhatsApp Oficial',
        status: 'connected',
        phoneNumber: phoneInfo?.display_phone_number ?? null,
        credentials,
        providerMeta,
      })
    }
  } catch (writeError) {
    console.error('[embedded-signup] save failed:', writeError)
    return NextResponse.json(
      { error: 'Falha ao salvar o canal' },
      { status: 500 },
    )
  }

  console.log(
    `[embedded-signup] connected account=${ctx.accountId} phone_number_id=${phoneNumberId} waba_id=${wabaId} subscribed=${subscribedAppsAt != null} registered=${registeredAt != null}${registrationError ? ` regError="${registrationError}"` : ''}`,
  )

  return NextResponse.json({
    success: true,
    phone_info: phoneInfo,
    waba_id: wabaId,
    subscribed: subscribedAppsAt != null,
  })
}
