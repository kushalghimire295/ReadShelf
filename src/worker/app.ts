import { Hono, type Handler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ItemKind } from '../shared/types'
import { ensureSchema, mapItem, type ItemRow } from './db'

export type Env = {
  ASSETS: Fetcher
  DB?: D1Database
  FILES?: R2Bucket
}

type AppContext = {
  Bindings: Env
  Variables: { db: D1Database }
}

/**
 * Readshelf has no accounts: everything on the shelf belongs to the reader
 * using it. The owner columns stay for the one identity so rows remain
 * self-describing.
 */
const VIEWER = { sub: 'local-reader', name: 'Reader' }

const MAX_UPLOAD = 15 * 1024 * 1024
const MAX_COVER = 5 * 1024 * 1024
const MAX_TITLE = 120
const COLUMNS =
  'id, owner_sub, owner_name, title, kind, mime, size, object_key, cover_key, cover_mime, visibility, reach, opens, shown, created_at, updated_at'

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

export function createApp(random: () => number = Math.random) {
  const app = new Hono<AppContext>()
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })

  app.get('/api/status', (c) =>
    c.json({ database: Boolean(c.env.DB), storage: Boolean(c.env.FILES) }),
  )

  const guard: Handler<AppContext> = async (c, next) => {
    const origin = c.req.header('Origin')
    if (origin && origin !== new URL(c.req.url).origin)
      return c.json({ error: 'Cross-origin request refused.' }, 403)
    if (!c.env.DB)
      return c.json(
        { error: 'This app is still being set up. Please try again later.' },
        503,
      )
    await ensureSchema(c.env.DB)
    c.set('db', c.env.DB)
    await next()
  }

  app.use('/api/items', guard)
  app.use('/api/items/*', guard)

  // The Home feed is a draw, not a list. Each public read's chance is 1/total,
  // and `shown` records how often it has already been drawn, so the least-shown
  // reads go first. Over a long run every read appears its exact share (two
  // reads: half the visits each) instead of relying on luck. Private reads are
  // never counted and never drawn.
  app.get('/api/feed', guard, async (c) => {
    const db = c.get('db')
    const rows = await db
      .prepare(
        `SELECT ${COLUMNS} FROM items WHERE visibility = 'public' LIMIT 500`,
      )
      .all<ItemRow>()
    const pool = [...rows.results]
    const total = pool.length
    const chance = total ? 1 / total : 0
    // How many reads this visit shows: the chance applied to the shelf, so the
    // long-run average matches the percentage shown on screen.
    const slots = total ? Math.max(1, Math.round(total * chance)) : 0

    // Shuffle first, then a stable sort by fewest appearances: ties rotate.
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
    }
    pool.sort((a, b) => a.shown - b.shown)
    const picked = pool.slice(0, slots)

    if (picked.length) {
      const placeholders = picked.map(() => '?').join(', ')
      await db
        .prepare(`UPDATE items SET shown = shown + 1 WHERE id IN (${placeholders})`)
        .bind(...picked.map((row) => row.id))
        .run()
    }

    return c.json({
      items: picked.map((row) => mapItem(row)),
      chance,
      total,
    })
  })

  // All-time ranking of public reads by how often they were opened.
  app.get('/api/popular', guard, async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        `SELECT ${COLUMNS} FROM items WHERE visibility = 'public' AND opens > 0 ORDER BY opens DESC, created_at DESC LIMIT 50`,
      )
      .all<ItemRow>()
    return c.json({ items: rows.results.map((row) => mapItem(row)) })
  })

  app.get('/api/items', guard, async (c) => {
    const rows = await c
      .get('db')
      .prepare(
        `SELECT ${COLUMNS} FROM items ORDER BY created_at DESC LIMIT 200`,
      )
      .all<ItemRow>()
    return c.json({ items: rows.results.map((row) => mapItem(row)) })
  })

  app.post(
    '/api/items',
    guard,
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
          {
            error:
              'Only PDFs, JPEG, PNG, WebP, GIF and AVIF images can go on the shelf.',
          },
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

      const id = crypto.randomUUID()
      const key = `items/${VIEWER.sub}/${id}`
      const coverKey = coverMime ? `${key}-cover` : null
      const now = Date.now()
      const item: ItemRow = {
        id,
        owner_sub: VIEWER.sub,
        owner_name: VIEWER.name,
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
        shown: 0,
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
      return c.json({ item: mapItem(item) }, 201)
    },
  )

  app.patch('/api/items/:id', guard, async (c) => {
    const parsed = parseJson(await c.req.json().catch(() => null))
    if ('error' in parsed) return c.json({ error: parsed.error }, 400)
    const db = c.get('db')
    const id = c.req.param('id')
    const current = await db
      .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`)
      .bind(id)
      .first<ItemRow>()
    if (!current) return c.json({ error: 'Item not found.' }, 404)

    const visibility = parsed.fields.visibility ?? current.visibility
    const updated = await db
      .prepare(
        `UPDATE items SET title = ?, visibility = ?, updated_at = ? WHERE id = ? RETURNING ${COLUMNS}`,
      )
      .bind(parsed.fields.title ?? current.title, visibility, Date.now(), id)
      .first<ItemRow>()
    return updated
      ? c.json({ item: mapItem(updated) })
      : c.json({ error: 'Item not found.' }, 404)
  })

  app.delete('/api/items/:id', guard, async (c) => {
    const removed = await c
      .get('db')
      .prepare(
        'DELETE FROM items WHERE id = ? RETURNING object_key, cover_key',
      )
      .bind(c.req.param('id'))
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
  app.post('/api/items/:id/open', guard, async (c) => {
    const id = c.req.param('id')
    const opened = await c
      .get('db')
      .prepare('UPDATE items SET opens = opens + 1 WHERE id = ? RETURNING opens')
      .bind(id)
      .first<{ opens: number }>()
    if (!opened) return c.json({ error: 'Item not found.' }, 404)
    return c.json({ opens: opened.opens })
  })

  app.get('/api/items/:id/file', guard, async (c) => {
    const bucket = c.env.FILES
    if (!bucket)
      return c.json(
        { error: 'Uploads are still being set up. Please try again later.' },
        503,
      )
    const row = await c
      .get('db')
      .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`)
      .bind(c.req.param('id'))
      .first<ItemRow>()
    if (!row) return c.json({ error: 'Item not found.' }, 404)
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
          row.visibility === 'public'
            ? 'private, max-age=300'
            : 'private, no-store',
        ETag: object.httpEtag,
      },
    })
  })

  // Covers are read by every card and row, so they follow the same rules as
  // the document itself.
  app.get('/api/items/:id/cover', guard, async (c) => {
    const bucket = c.env.FILES
    if (!bucket)
      return c.json(
        { error: 'Uploads are still being set up. Please try again later.' },
        503,
      )
    const row = await c
      .get('db')
      .prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`)
      .bind(c.req.param('id'))
      .first<ItemRow>()
    if (!row) return c.json({ error: 'Item not found.' }, 404)
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
          row.visibility === 'public'
            ? 'private, max-age=300'
            : 'private, no-store',
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
