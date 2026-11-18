import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp, type Env } from '../src/worker/app'

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

// A fixed draw of 0 includes every candidate, so feed assertions are stable;
// the sampling itself is exercised in its own test below.
const app = createApp(() => 0)
const ORIGIN = 'https://app.example.test'

/** Each test starts from an empty shelf so counts mean what they say. */
async function reset() {
  // A shelf request also creates the schema on the very first call.
  await call('/api/items')
  await env.DB!.prepare('DELETE FROM items').run()
}

const call = (path: string, method = 'GET', body?: unknown) =>
  app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
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
  origin?: string
  cover?: { mime: string; bytes?: number[] }
}

function upload({
  title = 'Field notes',
  visibility = 'public',
  mime = 'application/pdf',
  bytes = [37, 80, 68, 70, 45, 49],
  name = 'notes.pdf',
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
    { method: 'POST', headers: { Origin: origin }, body: form },
    env,
  )
}

const list = async (path: string) =>
  ((await (await call(path)).json()) as { items: { title: string }[] }).items

test('status reports the storage bindings and nothing about accounts', async () => {
  const status = (await (await call('/api/status')).json()) as Record<
    string,
    unknown
  >
  expect(status).toEqual({ database: true, storage: true })

  const noDb = await app.request(`${ORIGIN}/api/status`, {}, { ...env, DB: undefined })
  expect(await noDb.json()).toEqual({ database: false, storage: true })
  expect(
    (await app.request(`${ORIGIN}/api/items`, {}, { ...env, DB: undefined }))
      .status,
  ).toBe(503)
  expect((await call('/api/health')).status).toBe(200)
  expect(await (await call('/')).text()).toBe('public page')
})

test('public uploads appear on the Home feed and the shelf', async () => {
  await reset()
  const response = await upload({
    title: 'Shared sketch',
    mime: 'image/png',
    bytes: [137, 80, 78, 71],
    name: 'sketch.png',
  })
  expect(response.status).toBe(201)
  const { item } = (await response.json()) as {
    item: { id: string; kind: string; visibility: string }
  }
  expect(item).toMatchObject({ kind: 'image', visibility: 'public' })

  expect((await list('/api/feed')).map((entry) => entry.title)).toEqual([
    'Shared sketch',
  ])
  expect((await list('/api/items')).map((entry) => entry.title)).toEqual([
    'Shared sketch',
  ])

  const file = await call(`/api/items/${item.id}/file`)
  expect(file.status).toBe(200)
  expect(file.headers.get('Content-Type')).toBe('image/png')
  expect(file.headers.get('Content-Disposition')).toContain('inline')
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  )
})

test('the percentage holds over a long run and every read gets its turn', async () => {
  await reset()
  await upload({ title: 'One' })
  await upload({ title: 'Two' })
  const draw = createApp(() => 0.5)

  const first = (await (
    await draw.request(`${ORIGIN}/api/feed`, {}, env)
  ).json()) as {
    items: { title: string }[]
    chance: number
    total: number
  }
  // Two public reads means each has a 50% chance, so one of them shows.
  expect(first).toMatchObject({ total: 2, chance: 0.5 })
  expect(first.items).toHaveLength(1)

  await reset()
  const titles = ['A', 'B', 'C', 'D']
  for (const title of titles) await upload({ title })
  const counts = new Map<string, number>()
  for (let visit = 0; visit < 40; visit += 1) {
    const body = (await (
      await draw.request(`${ORIGIN}/api/feed`, {}, env)
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
    await draw.request(`${ORIGIN}/api/feed`, {}, env)
  ).json()) as { total: number; chance: number }
  expect(after).toMatchObject({ total: 4, chance: 0.25 })
  expect(await list('/api/items')).toHaveLength(5)
})

test('private uploads stay off the feed but remain readable', async () => {
  await reset()
  const created = (await (
    await upload({ title: 'Private diary', visibility: 'private' })
  ).json()) as { item: { id: string; visibility: string } }
  expect(created.item.visibility).toBe('private')

  expect(await list('/api/feed')).toHaveLength(0)
  expect((await list('/api/items')).map((entry) => entry.title)).toEqual([
    'Private diary',
  ])

  const file = await call(`/api/items/${created.item.id}/file`)
  expect(file.status).toBe(200)
  expect(file.headers.get('Cache-Control')).toContain('no-store')
})

test('sharing flips feed membership and deleting removes the stored file', async () => {
  await reset()
  const created = (await (
    await upload({ title: 'Move me' })
  ).json()) as { item: { id: string } }
  expect(await list('/api/feed')).toHaveLength(1)

  const hidden = await call(`/api/items/${created.item.id}`, 'PATCH', {
    visibility: 'private',
  })
  expect(hidden.status).toBe(200)
  expect(await hidden.json()).toMatchObject({
    item: { visibility: 'private' },
  })
  expect(await list('/api/feed')).toHaveLength(0)

  const reshared = await call(`/api/items/${created.item.id}`, 'PATCH', {
    visibility: 'public',
    title: 'Move me again',
  })
  expect(await reshared.json()).toMatchObject({
    item: { visibility: 'public', title: 'Move me again' },
  })
  expect((await list('/api/feed')).map((entry) => entry.title)).toEqual([
    'Move me again',
  ])

  expect((await call(`/api/items/${created.item.id}`, 'DELETE')).status).toBe(
    200,
  )
  expect(await list('/api/items')).toHaveLength(0)
  expect((await call(`/api/items/${created.item.id}/file`)).status).toBe(404)
  expect((await call(`/api/items/${created.item.id}`, 'DELETE')).status).toBe(
    404,
  )
})

test('rejects unsupported types, bad metadata, foreign origins and huge uploads', async () => {
  // Bun's FormData derives the part type from the filename, so these use
  // matching names; the server sees text/html and application/zip.
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
        { method: 'POST', headers: { Origin: ORIGIN }, body: noFile },
        env,
      )
    ).status,
  ).toBe(400)

  for (const body of [
    {},
    { title: '' },
    { visibility: 'shared' },
    { reach: 25 },
    { owner_sub: 'someone' },
  ]) {
    expect((await call('/api/items/whatever', 'PATCH', body)).status).toBe(400)
  }
})

test('opens are counted and rank public reads only', async () => {
  await reset()
  const leader = (await (
    await upload({ title: 'Ranked read' })
  ).json()) as { item: { id: string; opens: number } }
  expect(leader.item.opens).toBe(0)

  const open = (id: string) => call(`/api/items/${id}/open`, 'POST')
  expect((await open(leader.item.id)).status).toBe(200)
  expect(await (await open(leader.item.id)).json()).toEqual({ opens: 2 })

  const runnerUp = (await (
    await upload({ title: 'Runner up' })
  ).json()) as { item: { id: string } }
  expect((await open(runnerUp.item.id)).status).toBe(200)

  const privateItem = (await (
    await upload({ title: 'Secret notes', visibility: 'private' })
  ).json()) as { item: { id: string } }
  expect((await open(privateItem.item.id)).status).toBe(200)

  const ranking = (await (await call('/api/popular')).json()) as {
    items: { title: string; opens: number }[]
  }
  expect(ranking.items.map((entry) => entry.title)).toEqual([
    'Ranked read',
    'Runner up',
  ])
  expect(ranking.items[0]!.opens).toBe(2)

  // A private read still shows its own opens on the shelf.
  const shelf = (await (await call('/api/items')).json()) as {
    items: { title: string; opens: number }[]
  }
  expect(shelf.items.find((entry) => entry.title === 'Secret notes')?.opens).toBe(
    1,
  )
})

test('a separate cover image is stored, served and optional', async () => {
  await reset()
  const covered = (await (
    await upload({
      title: 'Covered read',
      cover: { mime: 'image/png', bytes: [137, 80, 78, 71] },
    })
  ).json()) as { item: { id: string; hasCover: boolean } }
  expect(covered.item.hasCover).toBe(true)

  const cover = await call(`/api/items/${covered.item.id}/cover`)
  expect(cover.status).toBe(200)
  expect(cover.headers.get('Content-Type')).toBe('image/png')
  expect(new Uint8Array(await cover.arrayBuffer())).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  )

  const plain = (await (await upload({ title: 'No cover read' })).json()) as {
    item: { id: string; hasCover: boolean }
  }
  expect(plain.item.hasCover).toBe(false)
  expect((await call(`/api/items/${plain.item.id}/cover`)).status).toBe(404)

  expect(
    (await upload({ title: 'Bad cover', cover: { mime: 'application/pdf' } }))
      .status,
  ).toBe(415)
})

test('missing database or bucket reports setup instead of failing', async () => {
  expect(
    (
      await app.request(
        `${ORIGIN}/api/items`,
        { method: 'POST', headers: { Origin: ORIGIN } },
        { ...env, FILES: undefined },
      )
    ).status,
  ).toBe(503)

  const page = await app.request(
    `${ORIGIN}/`,
    {},
    { ...env, DB: undefined, ASSETS: env.ASSETS },
  )
  expect(await page.text()).toBe('public page')
})
