import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders as supabaseCorsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { sendPushToUser } from '../_shared/fcm.ts'

const corsHeaders = {
  ...supabaseCorsHeaders,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type CallAction = 'start' | 'accept' | 'decline' | 'end' | 'turn-credentials'
type CallSession = {
  id: string
  conversation_id: string
  caller_id: string
  callee_id: string
  call_type: 'audio' | 'video'
  status: 'ringing' | 'accepted' | 'declined' | 'missed' | 'ended'
  created_at: string
  accepted_at: string | null
  expires_at: string
  ended_at: string | null
}

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

async function authenticatedClients(request: Request) {
  const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!accessToken) throw new RequestError(401, 'A valid signed-in session is required.')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new RequestError(500, 'Supabase function secrets are not configured.')

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: { user }, error } = await userClient.auth.getUser(accessToken)
  if (error || !user) throw new RequestError(401, 'Your session is invalid or expired.')
  return { user, userClient, adminClient }
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function createTemporaryTurnCredentials(userId: string) {
  const urls = (Deno.env.get('TURN_URLS') ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const sharedSecret = Deno.env.get('TURN_SHARED_SECRET')
  if (!urls.length && !sharedSecret) return { configured: false, iceServers: [] }
  if (!urls.length || !sharedSecret || urls.some((url) => !/^turns?:/i.test(url))) {
    throw new RequestError(500, 'TURN_URLS and TURN_SHARED_SECRET must both be correctly configured.')
  }

  const expiry = Math.floor(Date.now() / 1000) + 60 * 60
  const username = `${expiry}:${userId}`
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(sharedSecret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(username)))
  const credential = btoa(Array.from(digest, (byte) => String.fromCharCode(byte)).join(''))
  return {
    configured: true,
    iceServers: [{ urls, username, credential }],
    expiresAt: new Date(expiry * 1000).toISOString(),
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' })

  try {
    const { user, userClient, adminClient } = await authenticatedClients(request)
    let body: { action?: CallAction; conversationId?: string; callId?: string; callType?: string }
    try {
      body = await request.json()
    } catch {
      return response(400, { error: 'Request body must be valid JSON.' })
    }
    if (!body || !['start', 'accept', 'decline', 'end', 'turn-credentials'].includes(body.action ?? '')) {
      return response(400, { error: 'Unsupported call action.' })
    }

    if (body.action === 'turn-credentials') {
      return response(200, await createTemporaryTurnCredentials(user.id))
    }

    if (body.action === 'start') {
      if (!body.conversationId || !['audio', 'video'].includes(body.callType ?? '')) {
        return response(400, { error: 'A direct conversation and valid call type are required.' })
      }
      const { data, error } = await userClient.rpc('start_peer_call', {
        target_conversation: body.conversationId,
        requested_call_type: body.callType,
      })
      if (error) {
        if (error.code === '23505') return response(409, { error: 'One of the participants is already in a call.' })
        if (error.code === '42501') return response(403, { error: error.message })
        if (error.code === '22023') return response(400, { error: error.message })
        return response(500, { error: error.message })
      }
      const call = data as CallSession
      let notificationWarning: string | undefined
      try {
        const pushResult = await sendPushToUser(adminClient, call.callee_id, {
          title: 'Incoming J3FX call',
          body: `Incoming ${call.call_type} call`,
          data: {
            type: 'incoming_call',
            callId: call.id,
            conversationId: call.conversation_id,
            callType: call.call_type,
          },
          channelId: 'incoming_calls',
          sound: 'incoming_call',
          priority: 'HIGH',
          ttl: '60s',
        })
        if (pushResult.sent === 0) {
          notificationWarning = 'Call started, but the recipient has no registered Android notification device. In-app ringing may still work.'
        }
      } catch (pushError) {
        console.error('Incoming call push notification failed:', pushError)
        notificationWarning = 'Call started, but the background call notification could not be sent. Check the Firebase server credentials; in-app ringing may still work.'
      }
      return response(201, { call, notificationWarning })
    }

    if (!body.callId) return response(400, { error: 'A call ID is required.' })
    const { data: call, error: lookupError } = await userClient
      .from('call_sessions')
      .select('id,conversation_id,caller_id,callee_id,call_type,status,created_at,accepted_at,expires_at,ended_at')
      .eq('id', body.callId)
      .maybeSingle()
    if (lookupError) return response(500, { error: lookupError.message })
    if (!call) return response(404, { error: 'Call not found or you are not a participant.' })
    if (call.caller_id !== user.id && call.callee_id !== user.id) {
      return response(403, { error: 'You are not a participant in this call.' })
    }

    if (body.action === 'accept' || body.action === 'decline') {
      if (user.id !== call.callee_id) return response(403, { error: 'Only the invited recipient can accept or decline this call.' })
      if (call.status !== 'ringing' || Date.parse(call.expires_at) <= Date.now()) {
        return response(410, { error: 'This call invitation has expired or is no longer available.' })
      }
      const accepted = body.action === 'accept'
      const update = {
        status: accepted ? 'accepted' : 'declined',
        accepted_at: accepted ? new Date().toISOString() : null,
        expires_at: accepted ? new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() : call.expires_at,
        ended_at: accepted ? null : new Date().toISOString(),
      }
      const { data: updated, error: updateError } = await adminClient
        .from('call_sessions')
        .update(update)
        .eq('id', call.id)
        .eq('status', 'ringing')
        .gt('expires_at', new Date().toISOString())
        .select('id,status')
        .maybeSingle()
      if (updateError) return response(500, { error: updateError.message })
      if (!updated) return response(409, { error: 'This invitation was already accepted, declined, or expired.' })
      if (!accepted) {
        const { error: cleanupError } = await adminClient.from('call_signals').delete().eq('call_id', call.id)
        if (cleanupError) console.error('Declined call signaling cleanup failed:', cleanupError.message)
      }
      return response(200, { callId: call.id, status: update.status })
    }

    if (body.action === 'end') {
      if (!['ringing', 'accepted'].includes(call.status)) {
        return response(200, { callId: call.id, status: call.status })
      }
      const nextStatus = call.status === 'ringing' ? 'missed' : 'ended'
      const { error: endError } = await adminClient
        .from('call_sessions')
        .update({ status: nextStatus, ended_at: new Date().toISOString() })
        .eq('id', call.id)
        .in('status', ['ringing', 'accepted'])
      if (endError) return response(500, { error: endError.message })
      const { error: cleanupError } = await adminClient.from('call_signals').delete().eq('call_id', call.id)
      if (cleanupError) console.error('Ended call signaling cleanup failed:', cleanupError.message)
      return response(200, { callId: call.id, status: nextStatus })
    }

    return response(400, { error: 'Unsupported call action.' })
  } catch (error) {
    if (error instanceof RequestError) return response(error.status, { error: error.message })
    console.error('Call signaling function failed:', error)
    return response(500, { error: 'Call signaling request failed. Check the Supabase function logs.' })
  }
})
