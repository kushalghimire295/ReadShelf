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
  /** True when the uploader supplied their own cover image. */
  hasCover: boolean
  /** Times this document has been opened, all time. */
  opens: number
  createdAt: number
  updatedAt: number
}

export type Session = {
  user: { sub: string; name?: string; email?: string } | null
  mode: 'ready' | 'setup'
  database: boolean
  storage: boolean
  /** Email codes can be delivered (or shown locally in development). */
  email: boolean
  google: boolean
  /** Loopback development shows the code instead of emailing it. */
  devCode: boolean
}
