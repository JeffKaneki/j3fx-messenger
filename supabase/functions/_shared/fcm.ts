import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export type PushPayload = {
  title: string
  body: string
  data: Record<string, string>
  channelId: string
  sound?: string
  priority: 'HIGH' | 'NORMAL'
  ttl: string
}

let cachedAccessToken: { value: string; expiresAt: number } | null = null

function encodeBase64Url(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function readServiceAccount() {
  const projectId = Deno.env.get('FIREBASE_PROJECT_ID')
  const clientEmail = Deno.env.get('FIREBASE_CLIENT_EMAIL')
  const privateKey = Deno.env.get('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n')
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase server credentials are not configured.')
  }
  return { projectId, clientEmail, privateKey }
}

async function getAccessToken() {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value
  }

  const { clientEmail, privateKey } = readServiceAccount()
  const pem = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '')
  const keyBytes = Uint8Array.from(atob(pem), (character) => character.charCodeAt(0))
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const unsignedAssertion = `${encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${encodeBase64Url(JSON.stringify(claims))}`
  const signature = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(unsignedAssertion),
  ))
  const assertion = `${unsignedAssertion}.${encodeBase64Url(signature)}`
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!response.ok) throw new Error('Firebase OAuth token request failed.')
  const tokenResponse: unknown = await response.json()
  if (
    !tokenResponse ||
    typeof tokenResponse !== 'object' ||
    !('access_token' in tokenResponse) ||
    typeof tokenResponse.access_token !== 'string' ||
    !('expires_in' in tokenResponse) ||
    typeof tokenResponse.expires_in !== 'number'
  ) {
    throw new Error('Firebase returned an invalid OAuth token response.')
  }
  cachedAccessToken = {
    value: tokenResponse.access_token,
    expiresAt: Date.now() + tokenResponse.expires_in * 1000,
  }
  return cachedAccessToken.value
}

export async function sendPushToUser(
  adminClient: SupabaseClient,
  userId: string,
  payload: PushPayload,
) {
  const { data: devices, error: deviceError } = await adminClient
    .from('push_devices')
    .select('token')
    .eq('user_id', userId)
  if (deviceError) throw new Error('Unable to load notification devices.')
  if (!devices?.length) return { configured: true, sent: 0 }

  const { projectId } = readServiceAccount()
  const accessToken = await getAccessToken()
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`
  const results = await Promise.all(devices.map(async ({ token }) => {
    const androidNotification: Record<string, string> = { channel_id: payload.channelId }
    if (payload.sound) androidNotification.sound = payload.sound
    if (payload.data.callId) androidNotification.tag = `call-${payload.data.callId}`

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: payload.title, body: payload.body },
          data: payload.data,
          android: {
            priority: payload.priority,
            ttl: payload.ttl,
            notification: androidNotification,
          },
        },
      }),
    })

    if (response.ok) return true
    const errorBody: unknown = await response.json().catch(() => null)
    const isUnregistered = Boolean(
      errorBody &&
      typeof errorBody === 'object' &&
      'error' in errorBody &&
      errorBody.error &&
      typeof errorBody.error === 'object' &&
      'details' in errorBody.error &&
      Array.isArray(errorBody.error.details) &&
      errorBody.error.details.some((detail: unknown) =>
        Boolean(
          detail &&
          typeof detail === 'object' &&
          'errorCode' in detail &&
          detail.errorCode === 'UNREGISTERED',
        ),
      ),
    )
    if (isUnregistered) {
      const { error: deleteError } = await adminClient.from('push_devices').delete().eq('token', token)
      if (deleteError) console.error('Unable to remove an expired push token:', deleteError.message)
      return false
    }
    throw new Error(`Firebase rejected a notification with HTTP ${response.status}.`)
  }))

  const sent = results.filter(Boolean).length
  if (sent !== devices.length) {
    console.warn(`Firebase delivered ${sent} of ${devices.length} notifications; expired tokens were removed.`)
  }
  return { configured: true, sent }
}
