import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders as supabaseCorsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { sendPushToUser } from '../_shared/fcm.ts'

const corsHeaders = {
  ...supabaseCorsHeaders,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function response(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders })
  if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' })

  try {
    const accessToken = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!accessToken) return response(401, { error: 'A signed-in session is required.' })
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return response(500, { error: 'Supabase function secrets are not configured.' })
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser(accessToken)
    if (authError || !user) return response(401, { error: 'Your session is invalid or expired.' })

    let body: { action?: string; messageId?: string }
    try {
      body = await request.json()
    } catch {
      return response(400, { error: 'Request body must be valid JSON.' })
    }
    if (body.action !== 'message' || !body.messageId) {
      return response(400, { error: 'A message notification action and message ID are required.' })
    }

    const { data: message, error: messageError } = await adminClient
      .from('messages')
      .select('id,conversation_id')
      .eq('id', body.messageId)
      .eq('sender_id', user.id)
      .maybeSingle()
    if (messageError) return response(500, { error: 'Unable to verify the sent message.' })
    if (!message) return response(404, { error: 'Message not found or not sent by this account.' })

    const { data: members, error: memberError } = await adminClient
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', message.conversation_id)
      .neq('user_id', user.id)
    if (memberError) return response(500, { error: 'Unable to find message recipients.' })

    const deliveries = await Promise.all((members ?? []).map(({ user_id }) =>
      sendPushToUser(adminClient, user_id, {
        title: 'New message',
        body: 'You have a new message.',
        data: {
          type: 'message',
          conversationId: message.conversation_id,
        },
        channelId: 'messages',
        priority: 'NORMAL',
        ttl: '3600s',
      }),
    ))
    return response(200, {
      recipients: members?.length ?? 0,
      delivered: deliveries.reduce((count, delivery) => count + delivery.sent, 0),
    })
  } catch (error) {
    console.error('Push notification request failed:', error)
    return response(502, { error: error instanceof Error ? error.message : 'Push notification delivery failed.' })
  }
})
