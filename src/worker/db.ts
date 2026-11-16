import type { Item, ItemKind, Visibility } from '../shared/types'

const table = [
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    visibility TEXT NOT NULL,
    reach INTEGER NOT NULL DEFAULT 0,
    opens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
]

// Indexes run after migrations, because they can reference added columns.
const indexes = [
  `CREATE INDEX IF NOT EXISTS items_owner_created ON items(owner_sub, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS items_public ON items(visibility, reach, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS items_popular ON items(visibility, opens DESC)`,
]

/** Columns added after the first release; each runs once and is then a no-op. */
const additions = [`ALTER TABLE items ADD COLUMN opens INTEGER NOT NULL DEFAULT 0`]

const ready = new WeakMap<D1Database, Promise<void>>()
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = (async () => {
      await db.batch(table.map((sql) => db.prepare(sql)))
      for (const sql of additions) {
        // "duplicate column name" simply means the migration already ran.
        await db.prepare(sql).run().catch(() => undefined)
      }
      await db.batch(indexes.map((sql) => db.prepare(sql)))
    })().catch((error) => {
      ready.delete(db)
      throw error
    })
    ready.set(db, pending)
  }
  return pending
}

export type ItemRow = {
  id: string
  owner_sub: string
  owner_name: string
  title: string
  kind: string
  mime: string
  size: number
  object_key: string
  visibility: string
  reach: number
  opens: number
  created_at: number
  updated_at: number
}

export const mapItem = (row: ItemRow, viewer: string): Item => ({
  id: row.id,
  title: row.title,
  kind: row.kind === 'pdf' ? 'pdf' : ('image' as ItemKind),
  visibility: row.visibility === 'private' ? 'private' : ('public' as Visibility),
  reach: row.reach,
  ownerName: row.owner_name,
  isOwner: row.owner_sub === viewer,
  size: row.size,
  opens: row.opens,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
