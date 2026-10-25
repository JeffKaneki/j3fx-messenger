import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = url && key ? createClient(url, key) : null

export async function invokeWithFreshSession<T>(
  functionName: string,
  options: { body?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  if (!supabase) return { data: null, error: new Error('Supabase is not configured.') }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
  if (sessionError) return { data: null, error: sessionError }
  if (!sessionData.session) {
    return { data: null, error: new Error('Your sign-in session has expired. Sign in again to continue.') }
  }

  let accessToken = sessionData.session.access_token
  const expiresAt = sessionData.session.expires_at
  const refreshAccessToken = async () => {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
    if (refreshError) {
      if (/invalid refresh token|refresh token.*not found/i.test(refreshError.message)) {
        const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' })
        if (signOutError) console.error('Could not clear the invalid local Supabase session:', signOutError.message)
        return { error: new Error('Your sign-in session is no longer valid. Please sign in again.') }
      }
      return { error: refreshError }
    }
    if (!refreshed.session) {
      return { error: new Error('Your sign-in session expired and could not be renewed. Please sign in again.') }
    }
    return { accessToken: refreshed.session.access_token }
  }

  if (expiresAt && expiresAt * 1000 <= Date.now() + 60_000) {
    const refreshed = await refreshAccessToken()
    if (refreshed.error) return { data: null, error: refreshed.error }
    accessToken = refreshed.accessToken
  }

  const invoke = (token: string) => supabase.functions.invoke<T>(functionName, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  })
  const result = await invoke(accessToken)
  if (!(result.error?.context instanceof Response) || result.error.context.status !== 401) return result

  const refreshed = await refreshAccessToken()
  if (refreshed.error) return { data: null, error: refreshed.error }
  return invoke(refreshed.accessToken)
}
