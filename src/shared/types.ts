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

export type User = {
  sub: string
  email?: string
  name?: string
}

export type Status = {
  database: boolean
  storage: boolean
  /** True when Supabase URL and anon key are configured. */
  supabase: boolean
  /** Public values the browser needs to start Google sign-in. */
  supabaseUrl: string
  supabaseAnonKey: string
}
