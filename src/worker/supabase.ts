/**
 * Supabase Auth is the only identity provider. The browser holds the session
 * (Google OAuth happens inside Supabase); the Worker verifies the access token
 * against Supabase before touching any data, so a request cannot invent a user.
 */

export type AuthUser = {
  /** Supabase user id; documents are scoped by it. */
  sub: string
  email?: string
  name?: string
}

export type SupabaseEnv = {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

export function supabaseConfigured(env: SupabaseEnv): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY)
}

type Cached = { user: AuthUser | null; expires: number }
// Tokens are verified once a minute rather than on every file or cover request.
const verified = new Map<string, Cached>()

function bearer(request: Request): string {
  const header = request.headers.get('Authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

export async function verifySupabaseUser(
  request: Request,
  env: SupabaseEnv,
): Promise<AuthUser | null> {
  const token = bearer(request)
  if (!token || !supabaseConfigured(env)) return null

  const hit = verified.get(token)
  if (hit && hit.expires > Date.now()) return hit.user

  const base = env.SUPABASE_URL!.replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${token}`,
      },
    })
    if (!response.ok) {
      verified.set(token, { user: null, expires: Date.now() + 30_000 })
      return null
    }
    const info = (await response.json()) as {
      id?: string
      email?: string
      user_metadata?: {
        full_name?: string
        name?: string
        user_name?: string
      }
    }
    if (!info.id) return null
    const user: AuthUser = {
      sub: info.id,
      email: info.email,
      name:
        info.user_metadata?.full_name ||
        info.user_metadata?.name ||
        info.user_metadata?.user_name ||
        info.email,
    }
    verified.set(token, { user, expires: Date.now() + 60_000 })
    return user
  } catch {
    return null
  }
}

/** Tests share one process, so cached verifications can be dropped. */
export function resetVerificationCache(): void {
  verified.clear()
}
