import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Miniflare } from 'miniflare'
import { createApp } from '../src/worker/app'
import { currentUser, type Env } from '../src/worker/auth'

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
    APP_ORIGIN: 'https://app.example.test',
    ASSETS: {
      fetch: async () => new Response('public page'),
    } as unknown as Fetcher,
  }
}, 20_000)
afterAll(() => runtime.dispose())

// This identity seam exists only in the app factory. The Worker entrypoint
// never reads these test headers and always calls the real auth SDK.
const app = createApp(async (request) => {
  const sub = request.headers.get('test-user')
  return sub ? { sub, name: sub === 'alice' ? 'Alice' : 'Bob' } : null
})

const call = (
  path: string,
  user?: string,
  method = 'GET',
  body?: unknown,
  origin = env.APP_ORIGIN!,
) =>
  app.request(
    `https://app.example.test${path}`,
    {
      method,
      headers: {
        ...(user ? { 'test-user': user } : {}),
        Origin: origin,
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
}

function upload({
  title = 'Field notes',
  visibility = 'public',
  mime = 'application/pdf',
  bytes = [37, 80, 68, 70, 45, 49],
  name = 'notes.pdf',
  user = 'alice',
  origin = env.APP_ORIGIN!,
}: Upload = {}) {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(bytes)], name, { type: mime }))
  form.append('title', title)
  form.append('visibility', visibility)
  return app.request(
    'https://app.example.test/api/items',
    {
      method: 'POST',
      headers: { ...(user ? { 'test-user': user } : {}), Origin: origin },
      body: form,
    },
    env,
  )
}

const items = async (path: string, user: string) =>
  ((await (await call(path, user)).json()) as { items: { id: string; title: string }[] })
    .items

test('signed-out callers cannot read shelves, feeds or files', async () => {
  for (const [path, method] of [
    ['/api/feed', 'GET'],
    ['/api/items', 'GET'],
    ['/api/items', 'POST'],
    ['/api/items/absent', 'PATCH'],
    ['/api/items/absent', 'DELETE'],
    ['/api/items/absent/file', 'GET'],
  ]) {
    const response = await call(path!, undefined, method)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  }
  expect(await (await call('/')).text()).toBe('public page')
  expect((await call('/api/health')).status).toBe(200)
})

test('private uploads are only visible to their owner', async () => {
  const response = await upload({ visibility: 'private', title: 'Private diary' })
  expect(response.status).toBe(201)
  const { item } = (await response.json()) as { item: { id: string } }

  expect((await items('/api/items', 'alice')).map((entry) => entry.title)).toEqual([
    'Private diary',
  ])
  expect(await items('/api/items', 'bob')).toHaveLength(0)
  expect(await items('/api/feed', 'bob')).toHaveLength(0)

  expect((await call(`/api/items/${item.id}/file`, 'bob')).status).toBe(404)
  const own = await call(`/api/items/${item.id}/file`, 'alice')
  expect(own.status).toBe(200)
  expect(own.headers.get('Content-Type')).toBe('application/pdf')
  expect(own.headers.get('Cache-Control')).toContain('no-store')
  expect(new Uint8Array(await own.arrayBuffer())).toEqual(
    new Uint8Array([37, 80, 68, 70, 45, 49]),
  )
})

test('public uploads surface in other feeds and serve their bytes', async () => {
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
  expect(item).not.toHaveProperty('reach')

  expect((await items('/api/feed', 'bob')).map((entry) => entry.title)).toEqual([
    'Shared sketch',
  ])
  // The owner sees their own work on their shelf, not in their own feed.
  expect(await items('/api/feed', 'alice')).toHaveLength(0)

  const file = await call(`/api/items/${item.id}/file`, 'bob')
  expect(file.status).toBe(200)
  expect(file.headers.get('Content-Type')).toBe('image/png')
  expect(file.headers.get('Content-Disposition')).toContain('inline')
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(
    new Uint8Array([137, 80, 78, 71]),
  )

  // Public simply means public: no percentage gates the feed.
  await upload({ title: 'Second read' })
  expect((await items('/api/feed', 'bob')).map((entry) => entry.title)).toEqual([
    'Second read',
    'Shared sketch',
  ])
})

test('sharing can change and deleting removes the stored file', async () => {
  const before = (await items('/api/feed', 'bob')).length
  const created = (await (
    await upload({ title: 'Move me' })
  ).json()) as { item: { id: string } }
  expect(await items('/api/feed', 'bob')).toHaveLength(before + 1)

  const hidden = await call(`/api/items/${created.item.id}`, 'alice', 'PATCH', {
    visibility: 'private',
  })
  expect(hidden.status).toBe(200)
  expect(await hidden.json()).toMatchObject({
    item: { visibility: 'private' },
  })
  expect(await items('/api/feed', 'bob')).toHaveLength(before)
  expect((await call(`/api/items/${created.item.id}/file`, 'bob')).status).toBe(
    404,
  )

  const reshared = await call(`/api/items/${created.item.id}`, 'alice', 'PATCH', {
    visibility: 'public',
    title: 'Move me again',
  })
  expect(await reshared.json()).toMatchObject({
    item: { visibility: 'public', title: 'Move me again' },
  })

  expect(
    (await call(`/api/items/${created.item.id}`, 'bob', 'DELETE')).status,
  ).toBe(404)
  expect(
    (await call(`/api/items/${created.item.id}`, 'alice', 'DELETE')).status,
  ).toBe(200)
  expect(await items('/api/items', 'alice')).not.toContainEqual(
    expect.objectContaining({ id: created.item.id }),
  )
  expect((await call(`/api/items/${created.item.id}/file`, 'alice')).status).toBe(
    404,
  )
})

test('rejects unsupported types, bad metadata, foreign origins and huge uploads', async () => {
  // Bun's FormData derives the part type from the filename, so these use
  // matching names; the server sees text/html and application/zip.
  expect(
    (await upload({ mime: 'text/html', name: 'page.html' })).status,
  ).toBe(415)
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
        'https://app.example.test/api/items',
        {
          method: 'POST',
          headers: { 'test-user': 'alice', Origin: env.APP_ORIGIN! },
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
    expect(
      (await call('/api/items/whatever', 'alice', 'PATCH', body)).status,
    ).toBe(400)
  }
})

test('opens are counted per permitted reader and ranked, private items excluded', async () => {
  const leader = (await (
    await upload({ title: 'Ranked read' })
  ).json()) as { item: { id: string; opens: number } }
  expect(leader.item.opens).toBe(0)

  const open = (id: string, user: string) =>
    call(`/api/items/${id}/open`, user, 'POST')
  expect((await open(leader.item.id, 'bob')).status).toBe(200)
  expect((await open(leader.item.id, 'bob')).status).toBe(200)
  expect(await (await open(leader.item.id, 'alice')).json()).toEqual({
    opens: 3,
  })

  const runnerUp = (await (
    await upload({ title: 'Runner up' })
  ).json()) as { item: { id: string } }
  expect((await open(runnerUp.item.id, 'bob')).status).toBe(200)

  const privateItem = (await (
    await upload({ title: 'Secret notes', visibility: 'private' })
  ).json()) as { item: { id: string } }
  // Someone else cannot open it, and it never enters the public ranking.
  expect((await open(privateItem.item.id, 'bob')).status).toBe(404)
  expect((await open(privateItem.item.id, 'alice')).status).toBe(200)

  const ranking = (await (
    await call('/api/popular', 'bob')
  ).json()) as { items: { title: string; opens: number }[] }
  expect(ranking.items.map((entry) => entry.title).slice(0, 2)).toEqual([
    'Ranked read',
    'Runner up',
  ])
  expect(ranking.items[0]!.opens).toBe(3)
  expect(ranking.items.map((entry) => entry.title)).not.toContain(
    'Secret notes',
  )
  // Own public opens still show on the shelf, with the fresh count.
  const shelf = (await (
    await call('/api/items', 'alice')
  ).json()) as { items: { title: string; opens: number }[] }
  expect(shelf.items.find((entry) => entry.title === 'Secret notes')?.opens).toBe(
    1,
  )
})

test('missing storage or database reports setup and local preview stays local', async () => {
  expect(
    (
      await app.request(
        'https://app.example.test/api/items',
        { headers: { 'test-user': 'alice' } },
        { ...env, DB: undefined },
      )
    ).status,
  ).toBe(503)
  const noBucket = (await (
    await app.request(
      'https://app.example.test/api/session',
      { headers: { 'test-user': 'alice' } },
      { ...env, FILES: undefined },
    )
  ).json()) as { storage: boolean }
  expect(noBucket.storage).toBe(false)
  expect(
    await currentUser(new Request('https://app.example.test/'), {} as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {
      APP_ORIGIN: 'https://app.example.test',
    } as Env),
  ).toBeNull()
  expect(
    await currentUser(new Request('http://localhost:5000/'), {} as Env),
  ).toMatchObject({ sub: 'local-preview' })
})
