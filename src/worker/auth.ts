/**
 * First-party authentication for Readshelf.
 *
 * - Google uses the standard OAuth 2.0 code flow.
 * - A successful sign-in ends in an HttpOnly session cookie, backed by a D1 row
 *   so a session can be revoked server-side.
 */

export type AuthUser = {
  /** Stable internal id; documents are scoped by it. */
  sub: string
  name?: string
  email?: string
}

export type Env = {
  ASSETS: Fetcher
  DB?: D1Database
  FILES?: R2Bucket
  /** Canonical public origin, e.g. https://readshelf.example. Optional locally. */
  APP_ORIGIN?: string
  /** 32+ random characters. Required on hosted origins. */
  SESSION_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const SESSION_COOKIE = 'readshelf_session'
const STATE_COOKIE = 'readshelf_oauth_state'
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000

export function isLoopback(request: Request): boolean {
  return LOOPBACK.has(new URL(request.url).hostname)
}

export function appOrigin(request: Request, env: Env): string | null {
  if (env.APP_ORIGIN) return env.APP_ORIGIN.replace(/\/+$/, '')
  return isLoopback(request) ? new URL(request.url).origin : null
}

/** Cookie-based auth still needs a same-origin check on state-changing calls. */
export function isSameOrigin(request: Request, origin: string): boolean {
  const sent = request.headers.get('Origin')
  if (sent) return sent === origin
  const site = request.headers.get('Sec-Fetch-Site')
  return site === 'same-origin'
}

export function googleEnabled(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

function sessionSecret(env: Env, request: Request): string | null {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 16)
    return env.SESSION_SECRET
  return isLoopback(request) ? 'readshelf-local-development-secret' : null
}

/* ---------- crypto and cookies ---------- */

const encoder = new TextEncoder()

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return hex(new Uint8Array(signature))
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomToken(bytes = 32): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return null
}

function serializeCookie(
  request: Request,
  name: string,
  value: string,
  maxAge: number,
): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

/* ---------- schema ---------- */

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
]

const ready = new WeakMap<D1Database, Promise<void>>()

export function ensureAuthSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = db
      .batch(schema.map((sql) => db.prepare(sql)))
      .then(() => undefined)
      .catch((error) => {
        ready.delete(db)
        throw error
      })
    ready.set(db, pending)
  }
  return pending
}

/* ---------- sessions ---------- */

type SessionRow = {
  expires_at: number
  id: string
  email: string
  name: string | null
}

export async function currentUser(
  request: Request,
  env: Env,
): Promise<AuthUser | null> {
  if (!env.DB) return null
  const raw = readCookie(request, SESSION_COOKIE)
  if (!raw) return null
  const [sid, signature] = raw.split('.')
  if (!sid || !signature) return null
  const secret = sessionSecret(env, request)
  if (!secret) return null
  if ((await hmac(secret, sid)) !== signature) return null

  await ensureAuthSchema(env.DB)
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.id, u.email, u.name
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
  )
    .bind(sid)
    .first<SessionRow>()
  if (!row) return null
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run()
    return null
  }
  return {
    sub: row.id,
    name: row.name ?? undefined,
    email: row.email ?? undefined,
  }
}

async function createSession(
  db: D1Database,
  userId: string,
  request: Request,
  env: Env,
): Promise<string> {
  const secret = sessionSecret(env, request)!
  const sid = randomToken(24)
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .bind(sid, userId, Date.now(), Date.now() + SESSION_TTL)
    .run()
  const token = `${sid}.${await hmac(secret, sid)}`
  return serializeCookie(request, SESSION_COOKIE, token, SESSION_TTL / 1000)
}

export function clearSessionCookie(request: Request): string {
  return serializeCookie(request, SESSION_COOKIE, '', 0)
}

export async function revokeSession(
  request: Request,
  env: Env,
): Promise<void> {
  if (!env.DB) return
  const raw = readCookie(request, SESSION_COOKIE)
  const sid = raw?.split('.')[0]
  if (!sid) return
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run()
}

/* ---------- users ---------- */

async function upsertUser(
  db: D1Database,
  email: string,
  name?: string,
): Promise<AuthUser> {
  const normalised = email.trim().toLowerCase()
  const now = Date.now()
  const existing = await db
    .prepare('SELECT id, email, name FROM users WHERE email = ?')
    .bind(normalised)
    .first<{ id: string; email: string; name: string | null }>()
  if (existing) {
    if (name && !existing.name)
      await db
        .prepare('UPDATE users SET name = ?, last_seen_at = ? WHERE id = ?')
        .bind(name.slice(0, 80), now, existing.id)
        .run()
    else
      await db
        .prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')
        .bind(now, existing.id)
        .run()
    return {
      sub: existing.id,
      email: existing.email,
      name: name || existing.name || undefined,
    }
  }
  const id = crypto.randomUUID()
  const display = (name || normalised.split('@')[0] || 'Reader').slice(0, 80)
  await db
    .prepare(
      'INSERT INTO users (id, email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, normalised, display, now, now)
    .run()
  return { sub: id, email: normalised, name: display }
}

/**
 * Developer convenience: documents uploaded before sign-in existed belong to
 * the loopback identity. The first real local sign-in adopts them.
 */
async function claimLegacyItems(
  db: D1Database,
  userId: string,
  name?: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE items SET owner_sub = ?, owner_name = ? WHERE owner_sub = 'local-preview'`,
    )
    .bind(userId, (name || 'Reader').slice(0, 80))
    .run()
    .catch(() => undefined)
}

/* ---------- Google ---------- */

export function googleAuthUrl(
  request: Request,
  env: Env,
): { location: string; cookie: string } | null {
  const origin = appOrigin(request, env)
  if (!origin || !googleEnabled(env)) return null
  const state = randomToken(16)
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!)
  url.searchParams.set('redirect_uri', `${origin}/api/auth/google/callback`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('prompt', 'select_account')
  return {
    location: url.toString(),
    cookie: serializeCookie(request, STATE_COOKIE, state, 600),
  }
}

export type GoogleResult =
  | { ok: true; cookie: string }
  | { ok: false; error: string }

export async function finishGoogle(
  db: D1Database,
  request: Request,
  env: Env,
): Promise<GoogleResult> {
  const origin = appOrigin(request, env)
  if (!origin || !googleEnabled(env))
    return { ok: false, error: 'Google sign-in is not configured yet.' }
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expected = readCookie(request, STATE_COOKIE)
  if (!code || !state || !expected || state !== expected)
    return { ok: false, error: 'That sign-in link expired. Please try again.' }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${origin}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })
    if (!tokenResponse.ok) return { ok: false, error: 'Google sign-in failed.' }
    const tokens = (await tokenResponse.json()) as { access_token?: string }
    if (!tokens.access_token)
      return { ok: false, error: 'Google sign-in failed.' }

    const infoResponse = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    )
    if (!infoResponse.ok) return { ok: false, error: 'Google sign-in failed.' }
    const info = (await infoResponse.json()) as {
      email?: string
      email_verified?: boolean
      name?: string
    }
    if (!info.email || info.email_verified === false)
      return { ok: false, error: 'Google did not share a verified email.' }

    await ensureAuthSchema(db)
    const user = await upsertUser(db, info.email, info.name)
    if (isLoopback(request)) await claimLegacyItems(db, user.sub, user.name)
    return { ok: true, cookie: await createSession(db, user.sub, request, env) }
  } catch {
    return { ok: false, error: 'Google sign-in failed. Please try again.' }
  }
}

export function clearStateCookie(request: Request): string {
  return serializeCookie(request, STATE_COOKIE, '', 0)
}
