import { Hono, type Handler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ItemKind } from '../shared/types'
import {
  allowsDevCode,
  appOrigin,
  clearSessionCookie,
  clearStateCookie,
  currentUser,
  emailConfigured,
  ensureAuthSchema,
  finishGoogle,
  googleAuthUrl,
  googleEnabled,
  isSameOrigin,
  revokeSession,
  startEmailCode,
  verifyEmailCode,
  type AuthUser,
  type Env,
} from './auth'
import { ensureSchema, mapItem, type ItemRow } from './db'

type AppContext = {
  Bindings: Env
  Variables: { user: AuthUser; db: D1Database }
}
type Authenticate = (request: Request, env: Env) => Promise<AuthUser | null>

const MAX_UPLOAD = 15 * 1024 * 1024
const MAX_COVER = 5 * 1024 * 1024
const MAX_TITLE = 120
const COLUMNS =
  'id, owner_sub, owner_name, title, kind, mime, size, object_key, cover_key, cover_mime, visibility, reach, opens, created_at, updated_at'

const TYPES: Record<string, { kind: ItemKind; ext: string }> = {
  'application/pdf': { kind: 'pdf', ext: 'pdf' },
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'image/gif': { kind: 'image', ext: 'gif' },
  'image/avif': { kind: 'image', ext: 'avif' },
}

/** A cover is always an image, never the document itself. */
const COVER_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.trim().replace(/\s+/g, ' ')
  return title && title.length <= MAX_TITLE ? title : null
}

function fileName(title: string, ext: string): string {
  const base =
    title
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .slice(0, 60)
      .replace(/\.+$/, '') || 'readshelf'
  return `${base}.${ext}`
}

type JsonFields = { title?: string; visibility?: 'public' | 'private' }

function parseJson(body: unknown): { error: string } | { fields: JsonFields } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { error: 'Send a JSON object.' }
  const input = body as Record<string, unknown>
  const allowed = ['title', 'visibility']
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    return { error: 'Unexpected field.' }
  if (!Object.keys(input).length) return { error: 'Nothing to update.' }

  const fields: JsonFields = {}
  if ('title' in input) {
    const title = cleanTitle(input.title)
    if (!title)
      return { error: `A title needs between 1 and ${MAX_TITLE} characters.` }
    fields.title = title
  }
  if ('visibility' in input) {
    if (input.visibility !== 'public' && input.visibility !== 'private')
      return { error: 'Visibility must be public or private.' }
    fields.visibility = input.visibility
  }
  return { fields }
}

/** Tests inject identities; production always uses the Freebuff SDK. */
export function createApp(authenticate: Authenticate = currentUser) {
  const app = new Hono<AppContext>()
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  app.get('/api/session', async (c) =>
    c.json({
      user: await authenticate(c.req.raw, c.env),
      mode: 'ready',
      database: Boolean(c.env.DB),
      storage: Boolean(c.env.FILES),
      email: emailConfigured(c.env) || allowsDevCode(c.req.raw, c.env),
      google: googleEnabled(c.env),
      devCode: allowsDevCode(c.req.raw, c.env),
    }),
  )

  /* ---------- auth ---------- */
  const authGuard: Handler<AppContext> = async (c, next) => {
    const origin = appOrigin(c.req.raw, c.env)
    if (!origin || !isSameOrigin(c.req.raw, origin))
      return c.json({ error: 'Cross-origin request refused.' }, 403)
    if (!c.env.DB)
      return c.json({ error: 'Sign-in is not set up yet.' }, 503)
    await next()
  }

  app.post('/api/auth/email', authGuard, async (c) => {
    const body = await c.req.json().catch(() => null)
    const result = await startEmailCode(
      c.env.DB!,
      (body as { email?: unknown } | null)?.email,
      c.req.raw,
      c.env,
    )
    if (!result.ok) return c.json({ error: result.error }, result.status)
    return c.json({ ok: true, devCode: result.devCode ?? null })
  })

  app.post('/api/auth/email/verify', authGuard, async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      email?: unknown
      code?: unknown
    } | null
    const result = await verifyEmailCode(
      c.env.DB!,
      body?.email,
      body?.code,
      c.req.raw,
      c.env,
    )
    if (!result.ok) return c.json({ error: result.error }, result.status)
    c.header('Set-Cookie', result.cookie)
    return c.json({ user: result.user })
  })

  app.post('/api/auth/signout', authGuard, async (c) => {
    await revokeSession(c.req.raw, c.env)
    return new Response(null, {
      status: 303,
      headers: { Location: '/', 'Set-Cookie': clearSessionCookie(c.req.raw) },
    })
  })

  app.get('/api/auth/google', async (c) => {
    const start = googleAuthUrl(c.req.raw, c.env)
    if (!start) return c.redirect('/?authError=google-unavailable', 303)
    return new Response(null, {
      status: 303,
      headers: { Location: start.location, 'Set-Cookie': start.cookie },
    })
  })

  app.get('/api/auth/google/callback', async (c) => {
    if (!c.env.DB) return c.redirect('/?authError=signin-unavailable', 303)
    const result = await finishGoogle(c.env.DB, c.req.raw, c.env)
    if (!result.ok)
      return new Response(null, {
        status: 303,
        headers: {
          Location: `/?authError=${encodeURIComponent(result.error)}`,
          'Set-Cookie': clearStateCookie(c.req.raw),
        },
      })
    const headers = new Headers({ Location: '/' })
    headers.append('Set-Cookie', result.cookie)
    headers.append('Set-Cookie', clearStateCookie(c.req.raw))
    return new Response(null, { status: 303, headers })
  })

  const guard: Handler<AppContext> = async (c, next) => {
    const user = await authenticate(c.req.raw, c.env)
    if (!user) return c.json({ error: 'Sign in required.' }, 401)
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const origin = appOrigin(c.req.raw, c.env)
      if (!origin || !isSameOrigin(c.req.raw, origin))
        return c.json({ error: 'Cross-origin request refused.' }, 403)
    }
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureAuthSchema(c.env.DB)
    await ensureSchema(c.env.DB)
    c.set('user', user)
    c.set('db', c.env.DB)
    await next()
  }
  // Both patterns are needed: `/api/items/*` does not match `/api/items`.
  app.use('/api/feed', guard)
  app.use('/api/popular', guard)
  app.use('/api/items', guard)
  app.use('/api/items/*', guard)

  app.get('/api/feed', async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        `SELECT ${COLUMNS} FROM items WHERE visibility = 'public' AND owner_sub <> ? ORDER BY created_at DESC LIMIT 60`,
      )
      .bind(c.get('user').sub)
      .all<ItemRow>()
    return c.json({
      items: rows.results.map((row) => mapItem(row, c.get('user').sub)),
    })
  })

  // All-time ranking. Private items never appear here, and only public opens
  // are counted by reachable readers, so it cannot reveal a private title.
  app.get('/api/popular', async (c) => {
    const viewer = c.get('user').sub
    const rows = await c
      .get('db')
      .prepare(
        `SELECT ${COLUMNS} FROM items WHERE visibility = 'public' AND opens > 0 ORDER BY opens DESC, created_at DESC LIMIT 50`,
      )
      .all<ItemRow>()
    return c.json({ items: rows.results.map((row) => mapItem(row, viewer)) })
  })

  app.get('/api/items', async (c) => {
    const viewer = c.get('user').sub
    const rows = await c
      .get('db')
      .prepare(
        `SELECT ${COLUMNS} FROM items WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 200`,
      )
      .bind(viewer)
      .all<ItemRow>()
    return c.json({ items: rows.results.map((row) => mapItem(row, viewer)) })
  })

  app.post(
    '/api/items',
    bodyLimit({
      maxSize: MAX_UPLOAD + MAX_COVER + 512 * 1024,
      onError: (c) =>
        c.json({ error: 'Files can be at most 15 MB and covers 5 MB.' }, 413),
    }),
    async (c) => {
      const bucket = c.env.FILES
      if (!bucket)
        return c.json(
          { error: 'Uploads are still being set up. Please try again later.' },
          503,
        )
      const form = await c.req.parseBody().catch(() => null)
      if (!form) return c.json({ error: 'Send a file to upload.' }, 400)

      const file = form.file
      if (!(file instanceof File) || !file.size)
        return c.json({ error: 'Choose a PDF or an image to upload.' }, 400)
      const mime = file.type.split(';')[0]!.trim().toLowerCase()
      const type = TYPES[mime]
      if (!type)
        return c.json(
          { error: 'Only PDFs, JPEG, PNG, WebP, GIF and AVIF images can go on the shelf.' },
          415,
        )
      if (file.size > MAX_UPLOAD)
        return c.json({ error: 'Files can be at most 15 MB.' }, 413)

      const fallback =
        file.name.replace(/\.[^.]+$/, '').slice(0, MAX_TITLE) || 'Untitled read'
      const title = cleanTitle(form.title) ?? cleanTitle(fallback)
      if (!title)
        return c.json({ error: `A title needs 1–${MAX_TITLE} characters.` }, 400)

      const visibility = form.visibility === 'private' ? 'private' : 'public'

      // The cover is optional; a separate image the uploader picks so the read
      // is recognisable wherever it appears.
      const cover = form.cover
      let coverMime: string | null = null
      let coverBytes: ArrayBuffer | null = null
      if (cover !== undefined && cover !== null && cover !== '') {
        if (!(cover instanceof File) || !cover.size)
          return c.json({ error: 'That cover image is empty.' }, 400)
        const coverType = cover.type.split(';')[0]!.trim().toLowerCase()
        if (!COVER_TYPES[coverType])
          return c.json(
            { error: 'A cover must be a JPEG, PNG, WebP, GIF or AVIF image.' },
            415,
          )
        if (cover.size > MAX_COVER)
          return c.json({ error: 'Covers can be at most 5 MB.' }, 413)
        coverMime = coverType
        coverBytes = await cover.arrayBuffer()
      }

      const user = c.get('user')
      const id = crypto.randomUUID()
      const key = `items/${user.sub}/${id}`
      const coverKey = coverMime ? `${key}-cover` : null
      const now = Date.now()
      const item: ItemRow = {
        id,
        owner_sub: user.sub,
        owner_name: (user.name || user.email || 'A reader').slice(0, 80),
        title,
        kind: type.kind,
        mime,
        size: file.size,
        object_key: key,
        cover_key: coverKey,
        cover_mime: coverMime,
        visibility,
        // `reach` predates plain public sharing; the column is kept at 0.
        reach: 0,
        opens: 0,
        created_at: now,
        updated_at: now,
      }
      // R2 needs a fixed-length body, and uploads are already capped above.
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: mime },
      })
      if (coverKey && coverBytes && coverMime)
        await bucket.put(coverKey, coverBytes, {
          httpMetadata: { contentType: coverMime },
        })
      try {
        await c
          .get('db')
          .prepare(
            `INSERT INTO items (id, owner_sub, owner_name, title, kind, mime, size, object_key, cover_key, cover_mime, visibility, reach, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            item.id,
            item.owner_sub,
            item.owner_name,
            item.title,
            item.kind,
            item.mime,
            item.size,
            item.object_key,
            item.cover_key,
            item.cover_mime,
            item.visibility,
            item.reach,
            item.created_at,
            item.updated_at,
          )
          .run()
      } catch (error) {
        await bucket
          .delete([key, ...(coverKey ? [coverKey] : [])])
          .catch(() => undefined)
        throw error
      }
      return c.json({ item: mapItem(item, user.sub) }, 201)
    },
  )

  app.patch('/api/items/:id', async (c) => {
    const parsed = parseJson(await c.req.json().catch(() => null))
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)
    const db = c.get('db')
    const owner = c.get('user').sub
    const id = c.req.param('id')
    const current = await db
      .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ? AND owner_sub = ?`)
      .bind(id, owner)
      .first<ItemRow>()
    if (!current) return c.json({ error: 'Item not found.' }, 404)

    const visibility = parsed.fields.visibility ?? current.visibility
    const updated = await db
      .prepare(
        `UPDATE items SET title = ?, visibility = ?, updated_at = ? WHERE id = ? AND owner_sub = ? RETURNING ${COLUMNS}`,
      )
      .bind(
        parsed.fields.title ?? current.title,
        visibility,
        Date.now(),
        id,
        owner,
      )
      .first<ItemRow>()
    return updated
      ? c.json({ item: mapItem(updated, owner) })
      : c.json({ error: 'Item not found.' }, 404)
  })

  app.delete('/api/items/:id', async (c) => {
    const db = c.get('db')
    const removed = await db
      .prepare(
        'DELETE FROM items WHERE id = ? AND owner_sub = ? RETURNING object_key, cover_key',
      )
      .bind(c.req.param('id'), c.get('user').sub)
      .first<{ object_key: string; cover_key: string | null }>()
    if (!removed) return c.json({ error: 'Item not found.' }, 404)
    // The row is the source of truth; a missing object is not an error.
    if (c.env.FILES) {
      const keys = [removed.object_key, removed.cover_key].filter(
        (key): key is string => Boolean(key),
      )
      await c.env.FILES.delete(keys).catch(() => undefined)
    }
    return c.json({ ok: true })
  })

  // Counting an open is separate from fetching bytes, so the reader records it
  // once per visit while previews and thumbnails stay uncounted.
  app.post('/api/items/:id/open', async (c) => {
    const db = c.get('db')
    const viewer = c.get('user').sub
    const id = c.req.param('id')
    const row = await db
      .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`)
      .bind(id)
      .first<ItemRow>()
    if (!row || (row.visibility !== 'public' && row.owner_sub !== viewer))
      return c.json({ error: 'Item not found.' }, 404)
    const opened = await db
      .prepare('UPDATE items SET opens = opens + 1 WHERE id = ? RETURNING opens')
      .bind(id)
      .first<{ opens: number }>()
    return c.json({ opens: opened?.opens ?? row.opens + 1 })
  })

  app.get('/api/items/:id/file', async (c) => {
    const bucket = c.env.FILES
    if (!bucket)
      return c.json(
        { error: 'Uploads are still being set up. Please try again later.' },
        503,
      )
    const viewer = c.get('user').sub
    const row = await c
      .get('db')
      .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`)
      .bind(c.req.param('id'))
      .first<ItemRow>()
    // Private items of other people are indistinguishable from missing ones.
    if (!row || (row.visibility !== 'public' && row.owner_sub !== viewer))
      return c.json({ error: 'Item not found.' }, 404)
    const object = await bucket.get(row.object_key)
    if (!object) return c.json({ error: 'This file is unavailable.' }, 404)

    // Buffered rather than streamed: files are capped at 15 MB and the length
    // is then exact for inline PDF/image viewers.
    const bytes = await object.arrayBuffer()
    return new Response(bytes, {
      headers: {
        'Content-Type': row.mime,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `inline; filename="${fileName(row.title, TYPES[row.mime]?.ext ?? 'bin')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control':
          row.visibility === 'public' ? 'private, max-age=300' : 'private, no-store',
        ETag: object.httpEtag,
      },
    })
  })

  // Covers are read by every card and row, so they follow the same access
  // rules as the document itself.
  app.get('/api/items/:id/cover', async (c) => {
    const bucket = c.env.FILES
    if (!bucket)
      return c.json(
        { error: 'Uploads are still being set up. Please try again later.' },
        503,
      )
    const viewer = c.get('user').sub
    const row = await c
      .get('db')
      .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`)
      .bind(c.req.param('id'))
      .first<ItemRow>()
    if (!row || (row.visibility !== 'public' && row.owner_sub !== viewer))
      return c.json({ error: 'Item not found.' }, 404)
    if (!row.cover_key) return c.json({ error: 'This read has no cover.' }, 404)
    const object = await bucket.get(row.cover_key)
    if (!object) return c.json({ error: 'This cover is unavailable.' }, 404)

    const bytes = await object.arrayBuffer()
    return new Response(bytes, {
      headers: {
        'Content-Type': row.cover_mime || 'image/jpeg',
        'Content-Length': String(bytes.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control':
          row.visibility === 'public' ? 'private, max-age=300' : 'private, no-store',
        ETag: object.httpEtag,
      },
    })
  })

  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/')
      ? c.json({ error: 'Endpoint not found.' }, 404)
      : c.env.ASSETS.fetch(c.req.raw),
  )
  app.onError((_error, c) =>
    c.json({ error: 'Something went wrong. Please try again.' }, 500),
  )
  return app
}
