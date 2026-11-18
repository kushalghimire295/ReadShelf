/**
 * Firebase Authentication is the identity provider. Google sign-in happens in
 * the browser through the Firebase SDK; the Worker verifies the resulting
 * Firebase ID token itself (RS256 against Google's published signing keys) so a
 * request cannot invent a user. No service account or admin key is needed.
 */

export type AuthUser = {
  /** Firebase uid; documents are scoped by it. */
  sub: string
  email?: string
  name?: string
}

export type FirebaseEnv = {
  FIREBASE_API_KEY?: string
  FIREBASE_AUTH_DOMAIN?: string
  FIREBASE_PROJECT_ID?: string
  FIREBASE_APP_ID?: string
}

export type FirebaseConfig = {
  apiKey: string
  authDomain: string
  projectId: string
  appId: string
}

/** These values are public by design; the browser needs them to sign in. */
export function firebaseConfig(env: FirebaseEnv): FirebaseConfig | null {
  if (!env.FIREBASE_API_KEY || !env.FIREBASE_PROJECT_ID || !env.FIREBASE_APP_ID)
    return null
  return {
    apiKey: env.FIREBASE_API_KEY,
    authDomain:
      env.FIREBASE_AUTH_DOMAIN || `${env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: env.FIREBASE_PROJECT_ID,
    appId: env.FIREBASE_APP_ID,
  }
}

export function firebaseConfigured(env: FirebaseEnv): boolean {
  return firebaseConfig(env) !== null
}

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'

type SigningKey = { kid?: string; kty?: string; n?: string; e?: string }

let signingKeys: { until: number; keys: SigningKey[] } | null = null

async function keySet(): Promise<SigningKey[]> {
  if (signingKeys && signingKeys.until > Date.now()) return signingKeys.keys
  const response = await fetch(JWKS_URL)
  if (!response.ok) throw new Error('Could not load Firebase signing keys.')
  const body = (await response.json()) as { keys?: SigningKey[] }
  const maxAge = Number(
    /max-age=(\d+)/.exec(response.headers.get('Cache-Control') ?? '')?.[1] ?? 3600,
  )
  signingKeys = {
    until: Date.now() + Math.max(60, maxAge) * 1000,
    keys: body.keys ?? [],
  }
  return signingKeys.keys
}

type Claims = {
  sub?: string
  aud?: string
  iss?: string
  exp?: number
  iat?: number
  email?: string
  email_verified?: boolean
  name?: string
}

function decode(part: string): string {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/')
  return atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
}

/** Verifies the JWT signature and every claim Firebase guarantees. */
async function verifyIdToken(
  token: string,
  projectId: string,
): Promise<Claims | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [rawHeader, rawPayload, rawSignature] = parts as [
    string,
    string,
    string,
  ]

  let header: { alg?: string; kid?: string }
  let claims: Claims
  try {
    header = JSON.parse(decode(rawHeader)) as typeof header
    claims = JSON.parse(decode(rawPayload)) as Claims
  } catch {
    return null
  }

  if (header.alg !== 'RS256' || !header.kid) return null
  if (claims.aud !== projectId) return null
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) return null
  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp <= now) return null
  if (typeof claims.iat !== 'number' || claims.iat > now + 60) return null
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128)
    return null

  try {
    const signature = Uint8Array.from(decode(rawSignature), (character) =>
      character.charCodeAt(0),
    )
    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
    for (const key of await keySet()) {
      if (key.kid !== header.kid) continue
      if (key.kty !== 'RSA' || !key.n || !key.e) continue
      const imported = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        imported,
        signature,
        signed,
      )
      if (valid) return claims
    }
  } catch {
    return null
  }
  return null
}

type Cached = { user: AuthUser | null; expires: number }
// Tokens are verified once per few minutes rather than on every file request.
const verified = new Map<string, Cached>()

function bearer(request: Request): string {
  const header = request.headers.get('Authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

export async function verifyFirebaseUser(
  request: Request,
  env: FirebaseEnv,
): Promise<AuthUser | null> {
  const config = firebaseConfig(env)
  if (!config) return null
  const token = bearer(request)
  if (!token) return null

  const hit = verified.get(token)
  if (hit && hit.expires > Date.now()) return hit.user

  const claims = await verifyIdToken(token, config.projectId)
  if (!claims || !claims.sub) {
    verified.set(token, { user: null, expires: Date.now() + 30_000 })
    return null
  }
  // A Google account's address is verified; anything else is not trusted.
  if (claims.email && claims.email_verified === false) return null

  const user: AuthUser = {
    sub: claims.sub,
    email: claims.email,
    name: claims.name || claims.email,
  }
  verified.set(token, {
    user,
    expires: Math.min(claims.exp! * 1000, Date.now() + 5 * 60 * 1000),
  })
  return user
}

/** Tests share one process, so cached verifications can be dropped. */
export function resetVerificationCache(): void {
  verified.clear()
  signingKeys = null
}
