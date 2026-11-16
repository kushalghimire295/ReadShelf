export type ItemKind = 'pdf' | 'image'
export type Visibility = 'public' | 'private'

export type Item = {
  id: string
  title: string
  kind: ItemKind
  visibility: Visibility
  ownerName: string
  isOwner: boolean
  size: number
  /** Times this document has been opened, all time. */
  opens: number
  createdAt: number
  updatedAt: number
}

export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'local' | 'freebuff' | 'setup'
  database: boolean
  storage: boolean
}
