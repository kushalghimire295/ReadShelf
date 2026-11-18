import { afterAll, beforeAll, expect, test } from 'bun:test'
import { generateKeyPairSync, sign } from 'node:crypto'
import { Miniflare } from 'miniflare'
import { createApp, type Env } from '../src/worker/app'
import { resetVerificationCache, firebaseConfig, verifyFirebaseUser } from '../src/worker/firebase'

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
 * The real verifier checks a Firebase ID token. Tests stand in for it with a
 * header so the shelf rules can be exercised without a network round trip.
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
  expect(status).toMatchObject({
    database: true,
    storage: true,
    firebase: true,
    firebaseConfig: {
      projectId: 'readshelf-1ca03',
      authDomain: 'readshelf-1ca03.firebaseapp.com',
    },
  })

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

test('Home lists every public read, never the private ones', async () => {
  await reset()
  await upload({ title: 'One', user: 'alice' })
  await upload({ title: 'Two', user: 'bob' })
  const app = createApp(identity, () => 0.5)
  const feed = async () =>
    (await (
      await app.request(
        `${ORIGIN}/api/feed`,
        { headers: { Authorization: 'Bearer alice' } },
        env,
      )
    ).json()) as { items: { title: string }[]; chance: number; total: number }

  // Two shared reads: both show up, not just the one a draw would pick.
  const first = await feed()
  expect(first).toMatchObject({ total: 2, chance: 1 })
  expect(first.items.map((entry) => entry.title).sort()).toEqual([
    'One',
    'Two',
  ])

  // Private reads stay off Home on every visit, whatever the draw does.
  await upload({ title: 'Hidden', visibility: 'private' })
  for (let visit = 0; visit < 3; visit += 1) {
    const body = await feed()
    expect(body.total).toBe(2)
    expect(body.items.map((entry) => entry.title).sort()).toEqual([
      'One',
      'Two',
    ])
  }

  // A bigger shelf comes back whole, so readers can scroll through all of it.
  await upload({ title: 'Three' })
  await upload({ title: 'Four' })
  const many = await feed()
  expect(many).toMatchObject({ total: 4, chance: 1 })
  expect(many.items.map((entry) => entry.title).sort()).toEqual([
    'Four',
    'One',
    'Three',
    'Two',
  ])
})

test('documents from before sign-in are adopted by the first account', async () => {
  await reset()
  await upload({ title: 'Old read', user: 'alice' })
  // A row left behind by the no-account era, with no adoption recorded yet.
  await env.DB!.prepare(
    `UPDATE items SET owner_sub = 'local-reader'`,
  ).run()
  await env.DB!.prepare('DELETE FROM app_meta').run()

  // The first account to sign in inherits the pre-account shelf.
  expect((await list('/api/items', 'bob')).map((entry) => entry.title)).toEqual([
    'Old read',
  ])
  expect(await list('/api/items', 'alice')).toHaveLength(0)

  // It happens once: the next account starts empty.
  await env.DB!.prepare(
    `UPDATE items SET owner_sub = 'local-reader'`,
  ).run()
  expect(await list('/api/items', 'alice')).toHaveLength(0)
})

test('Firebase ID tokens are verified against the project', async () => {
  resetVerificationCache()
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  const jwk = publicKey.export({ format: 'jwk' }) as {
    kty: string
    n: string
    e: string
  }
  const project = 'readshelf-test'
  const firebaseEnv: Env = {
    ...env,
    FIREBASE_API_KEY: 'web-api-key',
    FIREBASE_PROJECT_ID: project,
    FIREBASE_APP_ID: '1:123:web:abc',
  }

  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  const makeToken = (
    claims: Record<string, unknown> = {},
    key = privateKey,
  ) => {
    const header = encode({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
    const now = Math.floor(Date.now() / 1000)
    const payload = encode({
      iss: `https://securetoken.google.com/${project}`,
      aud: project,
      sub: 'firebase-uid',
      iat: now,
      exp: now + 3600,
      email: 'reader@gmail.com',
      email_verified: true,
      name: 'Real Reader',
      ...claims,
    })
    const signature = sign(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      key,
    ).toString('base64url')
    return `${header}.${payload}.${signature}`
  }

  const realFetch = globalThis.fetch.bind(globalThis)
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    seen.push(url)
    // Google's published keys, as the Worker would fetch them.
    if (url.includes('securetoken@system.gserviceaccount.com'))
      return Response.json(
        {
          keys: [
            {
              kid: 'test-key',
              kty: 'RSA',
              alg: 'RS256',
              use: 'sig',
              n: jwk.n,
              e: jwk.e,
            },
          ],
        },
        { headers: { 'Cache-Control': 'public, max-age=3600' } },
      )
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch

  const requestWith = (token: string) =>
    verifyFirebaseUser(
      new Request('https://app.example.test/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      firebaseEnv,
    )

  try {
    expect(await requestWith(makeToken())).toEqual({
      sub: 'firebase-uid',
      email: 'reader@gmail.com',
      name: 'Real Reader',
    })
    // Signed by a key Google never published.
    const impostor = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    }).privateKey
    expect(await requestWith(makeToken({}, impostor))).toBeNull()
    // Right signature, wrong project or issuer.
    expect(await requestWith(makeToken({ aud: 'someone-else' }))).toBeNull()
    expect(
      await requestWith(
        makeToken({ iss: 'https://securetoken.google.com/other' }),
      ),
    ).toBeNull()
    // Expired tokens are refused.
    expect(
      await requestWith(makeToken({ exp: Math.floor(Date.now() / 1000) - 5 })),
    ).toBeNull()
    // An unverified address is not an identity.
    expect(await requestWith(makeToken({ email_verified: false }))).toBeNull()
    expect(await requestWith('not-a-token')).toBeNull()
    expect(
      await verifyFirebaseUser(
        new Request('https://app.example.test/api/me'),
        firebaseEnv,
      ),
    ).toBeNull()
    // The built-in project is used unless the environment names another one.
    expect(
      firebaseConfig({ FIREBASE_PROJECT_ID: 'other-project' }),
    ).toMatchObject({
      projectId: 'other-project',
      authDomain: 'other-project.firebaseapp.com',
      apiKey: 'AIzaSyDzjVB3mb8gXZ3tMeSSxV_kKNwPBJU6NQY',
    })

    // The real app refuses the shelf for a token it cannot verify.
    const realApp = createApp()
    const denied = await realApp.request(
      `${ORIGIN}/api/items`,
      { headers: { Authorization: 'Bearer not-a-token' } },
      firebaseEnv,
    )
    expect(denied.status).toBe(401)
    const allowed = await realApp.request(
      `${ORIGIN}/api/me`,
      { headers: { Authorization: `Bearer ${makeToken()}` } },
      firebaseEnv,
    )
    expect(
      ((await allowed.json()) as { user: { email: string } }).user.email,
    ).toBe('reader@gmail.com')

    // Covers and documents are loaded by <img>/<iframe>, which cannot set a
    // header, so those reads accept the token in the query string instead.
    const form = new FormData()
    form.append(
      'file',
      new File([new Uint8Array([137, 80, 78, 71])], 'page.png', {
        type: 'image/png',
      }),
    )
    form.append(
      'cover',
      new File([new Uint8Array([1, 2, 3])], 'cover.png', {
        type: 'image/png',
      }),
    )
    form.append('title', 'Inline read')
    const created = await realApp.request(
      `${ORIGIN}/api/items`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${makeToken()}`, Origin: ORIGIN },
        body: form,
      },
      firebaseEnv,
    )
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { item: { id: string } }).item.id

    const inline = await realApp.request(
      `${ORIGIN}/api/items/${id}/file?t=${makeToken()}`,
      {},
      firebaseEnv,
    )
    expect(inline.status).toBe(200)
    expect(inline.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await inline.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    )
    const cover = await realApp.request(
      `${ORIGIN}/api/items/${id}/cover?t=${makeToken()}`,
      {},
      firebaseEnv,
    )
    expect(cover.status).toBe(200)

    // A leaked read link still cannot be replayed as a write.
    const write = await realApp.request(
      `${ORIGIN}/api/items/${id}?t=${makeToken()}`,
      { method: 'DELETE', headers: { Origin: ORIGIN } },
      firebaseEnv,
    )
    expect(write.status).toBe(401)
    // Verified against the project's signing keys, not a third-party API.
    expect(seen.some((url) => url.includes('securetoken@system.gserviceaccount.com'))).toBe(
      true,
    )
  } finally {
    globalThis.fetch = realFetch
    resetVerificationCache()
  }
})
