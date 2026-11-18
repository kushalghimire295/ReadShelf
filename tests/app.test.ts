import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp, type Env } from '../src/worker/app'
import { resetVerificationCache, verifySupabaseUser } from '../src/worker/supabase'

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'test-storage',
        compatibilityDate: '2026-11-11',
        manifest: {
          mainModule: 'index.js',
          modules: {
            'index.js': {
              type: 'esm',
              contents:
                'export default { fetch() { return new Response("test") } }',
            },
          },
        },
        env: {
          DB: { type: 'd1', name: 'items-test' },
          FILES: { type: 'r2', name: 'items-test' },
        },
      },
    },
  ],
  port: 0,
})
let env: Env
beforeAll(async () => {
  const db = await runtime.getD1Database('DB')
  const bucket = await runtime.getR2Bucket('FILES')
  env = {
    DB: db as unknown as D1Database,
    FILES: bucket as unknown as R2Bucket,
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

const ORIGIN = 'https://app.example.test'

/**
 * The real verifier calls Supabase. Tests stand in for it with a header so the
 * shelf rules can be exercised without a network round trip.
 */
const identity = async (request: Request) => {
  const token = (request.headers.get('Authorization') ?? '').replace(
    'Bearer ',
    '',
  )
  return token === 'alice' || token === 'bob'
    ? { sub: token, name: token === 'alice' ? 'Alice' : 'Bob' }
    : null
}

// A fixed draw of 0 keeps tie-breaking stable; fairness has its own test.
const app = createApp(identity, () => 0)

/** Each test starts from an empty shelf so counts mean what they say. */
async function reset() {
  // A guarded request creates the schema on the very first call.
  await call('/api/items', 'alice')
  await env.DB!.prepare('DELETE FROM items').run()
}

const call = (path: string, user?: string, method = 'GET', body?: unknown) =>
  app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        Origin: ORIGIN,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

type Upload = {
  title?: string
  visibility?: 'public' | 'private'
  mime?: string
  bytes?: number[]
  name?: string
  user?: string
  origin?: string
  cover?: { mime: string; bytes?: number[] }
}

function upload({
  title = 'Field notes',
  visibility = 'public',
  mime = 'application/pdf',
  bytes = [37, 80, 68, 70, 45, 49],
  name = 'notes.pdf',
  user = 'alice',
  origin = ORIGIN,
  cover,
}: Upload = {}) {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], name, { type: mime }))
  if (cover)
    form.append(
      'cover',
      // Bun re-derives a part's type from its filename, so match the extension.
      new File(
        [new Uint8Array(cover.bytes ?? [1, 2, 3])],
        `cover.${cover.mime.split('/')[1] ?? 'png'}`,
        { type: cover.mime },
      ),
    )
  form.append('title', title)
  form.append('visibility', visibility)
  return app.request(
    `${ORIGIN}/api/items`,
    {
      method: 'POST',
      headers: {
        ...(user ? { Authorization: `Bearer ${user}` } : {}),
        Origin: origin,
      },
      body: form,
    },
    env,
  )
}

const list = async (path: string, user = 'alice') =>
  ((await (await call(path, user)).json()) as { items: { title: string }[] })
    .items

test('the status is public but the shelf is not', async () => {
  const status = (await (await call('/api/status')).json()) as Record<
    string,
    unknown
  >
  expect(status).toMatchObject({ database: true, storage: true, supabase: false })

  // Without a token there is no user and no data.
  expect(((await (await call('/api/me')).json()) as { user: unknown }).user).toBeNull()
  for (const path of ['/api/feed', '/api/popular', '/api/items']) {
    const response = await call(path)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(
    (
      await app.request(
        `${ORIGIN}/api/items`,
        {
          method: 'POST',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: '{}',
        },
        env,
      )
    ).status,
  ).toBe(401)

  const me = (await (await call('/api/me', 'alice')).json()) as {
    user: { name: string }
  }
  expect(me.user.name).toBe('Alice')
  expect((await call('/api/items', 'alice')).status).toBe(200)
  expect(await (await call('/')).text()).toBe('public page')
})

test('private uploads stay on their owner’s shelf only', async () => {
  await reset()
  const created = (await (
    await upload({ title: 'Private diary', visibility: 'private' })
  ).json()) as { item: { id: string; visibility: string } }
  expect(created.item.visibility).toBe('private')

  expect((await list('/api/items', 'alice')).map((entry) => entry.title)).toEqual(
    ['Private diary'],
  )
  expect(await list('/api/items', 'bob')).toHaveLength(0)
  expect(await list('/api/feed', 'bob')).toHaveLength(0)

  // Bob gets the same 404 as for a missing item.
  expect((await call(`/api/items/${created.item.id}/file`, 'bob')).status).toBe(
    404,
  )
  const own = await call(`/api/items/${created.item.id}/file`, 'alice')
  expect(own.status).toBe(200)
  expect(own.headers.get('Cache-Control')).toContain('no-store')
})

test('public uploads reach other readers and serve their bytes', async () => {
  await reset()
  const created = (await (
    await upload({
      title: 'Shared sketch',
      mime: 'image/png',
      bytes: [137, 80, 78, 71],
      name: 'sketch.png',
    })
  ).json()) as { item: { id: string } }

  expect((await list('/api/feed', 'bob')).map((entry) => entry.title)).toEqual([
    'Shared sketch',
  ])
  // The owner keeps it on their own shelf, not on top of someone's feed copy.
  expect(await list('/api/items', 'bob')).toHaveLength(0)
  expect((await list('/api/items', 'alice')).map((entry) => entry.title)).toEqual([
    'Shared sketch',
  ])

  const file = await call(`/api/items/${created.item.id}/file`, 'bob')
  expect(file.status).toBe(200)
  expect(file.headers.get('Content-Type')).toBe('image/png')
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  )
})

test('only the owner can rename, reshare or delete', async () => {
  await reset()
  const created = (await (
    await upload({ title: 'Move me' })
  ).json()) as { item: { id: string } }
  expect(await list('/api/feed', 'bob')).toHaveLength(1)

  expect(
    (await call(`/api/items/${created.item.id}`, 'bob', 'PATCH', {
      visibility: 'private',
    })).status,
  ).toBe(404)
  expect(
    (await call(`/api/items/${created.item.id}`, 'bob', 'DELETE')).status,
  ).toBe(404)

  const hidden = await call(`/api/items/${created.item.id}`, 'alice', 'PATCH', {
    visibility: 'private',
  })
  expect(await hidden.json()).toMatchObject({ item: { visibility: 'private' } })
  expect(await list('/api/feed', 'bob')).toHaveLength(0)

  expect(
    (await call(`/api/items/${created.item.id}`, 'alice', 'DELETE')).status,
  ).toBe(200)
  expect(await list('/api/items', 'alice')).toHaveLength(0)
  expect((await call(`/api/items/${created.item.id}/file`, 'alice')).status).toBe(
    404,
  )
})

test('rejects unsupported types, bad metadata, foreign origins and huge uploads', async () => {
  expect((await upload({ mime: 'text/html', name: 'page.html' })).status).toBe(
    415,
  )
  expect((await upload({ mime: 'application/zip', name: 'a.zip' })).status).toBe(
    415,
  )
  expect((await upload({ origin: 'https://foreign.example' })).status).toBe(403)
  expect(
    (await upload({ bytes: new Array(16 * 1024 * 1024).fill(37) })).status,
  ).toBe(413)

  const noFile = new FormData()
  noFile.append('title', 'Nothing')
  expect(
    (
      await app.request(
        `${ORIGIN}/api/items`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer alice', Origin: ORIGIN },
          body: noFile,
        },
        env,
      )
    ).status,
  ).toBe(400)

  for (const body of [
    {},
    { title: '' },
    { visibility: 'shared' },
    { reach: 25 },
    { owner_sub: 'bob' },
  ]) {
    expect((await call('/api/items/whatever', 'alice', 'PATCH', body)).status).toBe(
      400,
    )
  }
})

test('opens count for permitted readers and rank public reads only', async () => {
  await reset()
  const leader = (await (
    await upload({ title: 'Ranked read' })
  ).json()) as { item: { id: string; opens: number } }
  expect(leader.item.opens).toBe(0)

  const open = (id: string, user: string) =>
    call(`/api/items/${id}/open`, user, 'POST')
  expect((await open(leader.item.id, 'bob')).status).toBe(200)
  expect(await (await open(leader.item.id, 'alice')).json()).toEqual({ opens: 2 })

  const privateItem = (await (
    await upload({ title: 'Secret notes', visibility: 'private' })
  ).json()) as { item: { id: string } }
  expect((await open(privateItem.item.id, 'bob')).status).toBe(404)
  expect((await open(privateItem.item.id, 'alice')).status).toBe(200)

  const ranking = (await (await call('/api/popular', 'bob')).json()) as {
    items: { title: string; opens: number }[]
  }
  expect(ranking.items.map((entry) => entry.title)).toEqual(['Ranked read'])
  expect(ranking.items[0]!.opens).toBe(2)

  const shelf = (await (await call('/api/items', 'alice')).json()) as {
    items: { title: string; opens: number }[]
  }
  expect(shelf.items.find((entry) => entry.title === 'Secret notes')?.opens).toBe(
    1,
  )
})

test('covers follow the same ownership rules as the document', async () => {
  await reset()
  const covered = (await (
    await upload({
      title: 'Covered read',
      cover: { mime: 'image/png', bytes: [137, 80, 78, 71] },
    })
  ).json()) as { item: { id: string; hasCover: boolean } }
  expect(covered.item.hasCover).toBe(true)

  const cover = await call(`/api/items/${covered.item.id}/cover`, 'bob')
  expect(cover.status).toBe(200)
  expect(cover.headers.get('Content-Type')).toBe('image/png')

  const hidden = (await (
    await upload({
      title: 'Hidden cover',
      visibility: 'private',
      cover: { mime: 'image/jpeg' },
    })
  ).json()) as { item: { id: string } }
  expect((await call(`/api/items/${hidden.item.id}/cover`, 'bob')).status).toBe(
    404,
  )
  expect(
    (await call(`/api/items/${hidden.item.id}/cover`, 'alice')).status,
  ).toBe(200)
})

test('the Home percentage holds over a long run and every read gets its turn', async () => {
  await reset()
  await upload({ title: 'One', user: 'alice' })
  await upload({ title: 'Two', user: 'bob' })
  const draw = createApp(identity, () => 0.5)

  const first = (await (
    await draw.request(
      `${ORIGIN}/api/feed`,
      { headers: { Authorization: 'Bearer alice' } },
      env,
    )
  ).json()) as { items: { title: string }[]; chance: number; total: number }
  expect(first).toMatchObject({ total: 2, chance: 0.5 })
  expect(first.items).toHaveLength(1)

  await reset()
  const titles = ['A', 'B', 'C', 'D']
  for (const title of titles) await upload({ title })
  const counts = new Map<string, number>()
  for (let visit = 0; visit < 40; visit += 1) {
    const body = (await (
      await draw.request(
        `${ORIGIN}/api/feed`,
        { headers: { Authorization: 'Bearer bob' } },
        env,
      )
    ).json()) as { items: { title: string }[]; chance: number }
    expect(body.chance).toBe(0.25)
    expect(body.items).toHaveLength(1)
    const title = body.items[0]!.title
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  // Forty visits at 25% each is ten appearances per read: the printed
  // percentage is a long-run promise, not a per-visit coin toss.
  for (const title of titles) expect(counts.get(title)).toBe(10)

  // Private reads change neither the total nor the draw.
  await upload({ title: 'Hidden', visibility: 'private' })
  const after = (await (
    await draw.request(
      `${ORIGIN}/api/feed`,
      { headers: { Authorization: 'Bearer bob' } },
      env,
    )
  ).json()) as { total: number; chance: number }
  expect(after).toMatchObject({ total: 4, chance: 0.25 })
})

test('Supabase access tokens are verified against the project', async () => {
  resetVerificationCache()
  const supabaseEnv: Env = {
    ...env,
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key',
  }
  const realFetch = globalThis.fetch.bind(globalThis)
  const seen: { url: string; apikey: string | null; authorization: string | null }[] =
    []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url === 'https://project.supabase.co/auth/v1/user') {
      const headers = new Headers(init?.headers)
      seen.push({
        url,
        apikey: headers.get('apikey'),
        authorization: headers.get('Authorization'),
      })
      if (headers.get('Authorization') === 'Bearer good-token')
        return Response.json({
          id: 'google-user-id',
          email: 'reader@gmail.com',
          user_metadata: { full_name: 'Real Reader' },
        })
      return new Response('{"message":"invalid token"}', { status: 401 })
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch

  try {
    const user = await verifySupabaseUser(
      new Request('https://app.example.test/api/me', {
        headers: { Authorization: 'Bearer good-token' },
      }),
      supabaseEnv,
    )
    expect(user).toEqual({
      sub: 'google-user-id',
      email: 'reader@gmail.com',
      name: 'Real Reader',
    })
    // The anon key identifies the project; the token identifies the reader.
    expect(seen[0]).toMatchObject({
      apikey: 'anon-key',
      authorization: 'Bearer good-token',
    })

    expect(
      await verifySupabaseUser(
        new Request('https://app.example.test/api/me', {
          headers: { Authorization: 'Bearer bad-token' },
        }),
        supabaseEnv,
      ),
    ).toBeNull()

    // With no project configured nobody can be authenticated.
    expect(
      await verifySupabaseUser(
        new Request('https://app.example.test/api/me', {
          headers: { Authorization: 'Bearer good-token' },
        }),
        { ...supabaseEnv, SUPABASE_URL: undefined },
      ),
    ).toBeNull()

    // The real app refuses the shelf for an unverifiable token.
    const realApp = createApp()
    const denied = await realApp.request(
      `${ORIGIN}/api/items`,
      { headers: { Authorization: 'Bearer bad-token' } },
      supabaseEnv,
    )
    expect(denied.status).toBe(401)
    const allowed = await realApp.request(
      `${ORIGIN}/api/me`,
      { headers: { Authorization: 'Bearer good-token' } },
      supabaseEnv,
    )
    expect(((await allowed.json()) as { user: { email: string } }).user.email).toBe(
      'reader@gmail.com',
    )
  } finally {
    globalThis.fetch = realFetch
    resetVerificationCache()
  }
})
