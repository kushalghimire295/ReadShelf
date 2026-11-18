import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { User } from '../shared/types'

let client: SupabaseClient | null = null
let token: string | null = null

/** The Worker checks this token with Supabase before returning any data. */
export const accessToken = (): string | null => token

export function createSupabase(url: string, anonKey: string): SupabaseClient {
  if (!client)
    client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // The OAuth redirect comes back to this page with a code to exchange.
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })
  return client
}

function toUser(value: {
  id: string
  email?: string
  user_metadata?: { full_name?: string; name?: string; user_name?: string }
}): User {
  return {
    sub: value.id,
    email: value.email,
    name:
      value.user_metadata?.full_name ||
      value.user_metadata?.name ||
      value.user_metadata?.user_name ||
      value.email,
  }
}

/** Reads the stored session (including one just returned by Google). */
export async function currentUser(): Promise<User | null> {
  if (!client) return null
  const { data } = await client.auth.getSession()
  token = data.session?.access_token ?? null
  if (!data.session?.user) return null
  client.auth.onAuthStateChange((_event, session) => {
    token = session?.access_token ?? null
  })
  return toUser(data.session.user)
}

export async function signInWithGoogle(): Promise<void> {
  if (!client) throw new Error('Sign-in is not configured on this site yet.')
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
      queryParams: { prompt: 'select_account' },
    },
  })
  if (error) throw new Error(error.message)
}

export async function signOut(): Promise<void> {
  token = null
  await client?.auth.signOut().catch(() => undefined)
}
