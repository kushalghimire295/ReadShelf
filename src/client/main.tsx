import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Item, Status, User, Visibility } from '../shared/types'
import {
  accessToken,
  describeAuthError,
  initFirebase,
  signInWithGoogle,
  signOut,
  watchUser,
} from './firebase'
import './style.css'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const token = accessToken()
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  const body = (await response.json().catch(() => {
    throw new Error('Could not reach Readshelf. Please try again.')
  })) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'The request failed. Please try again.')
  return body
}

// <img>, <iframe> and download links cannot send an Authorization header, so
// these reads carry the token in the URL instead.
const tokenQuery = () => `t=${encodeURIComponent(accessToken() ?? '')}`
const fileUrl = (item: Item) => `/api/items/${item.id}/file?${tokenQuery()}`
// Versioned so a replaced cover is not served from the browser cache.
const coverUrl = (item: Item) =>
  `/api/items/${item.id}/cover?v=${item.updatedAt}&${tokenQuery()}`

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function timeAgo(value: number): string {
  const seconds = Math.round((Date.now() - value) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle
        cx="10"
        cy="10"
        r="3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M10 2.6v1.8M10 15.6v1.8M2.6 10h1.8M15.6 10h1.8M4.6 4.6l1.3 1.3M14.1 14.1l1.3 1.3M15.4 4.6l-1.3 1.3M5.9 14.1l-1.3 1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M16.2 12.4A6.7 6.7 0 0 1 7.6 3.8a6.9 6.9 0 1 0 8.6 8.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

type View = 'home' | 'popular' | 'shelf' | 'adds' | 'add'

const NAV_ITEMS: { key: View; label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'popular', label: 'Most opened' },
  { key: 'shelf', label: 'My shelf' },
  { key: 'adds', label: 'My Adds' },
  { key: 'add', label: 'Add' },
]

function NavIcon({ name }: { name: View }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (name === 'home')
    return (
      <svg {...common}>
        <path d="M4 10.6 12 4l8 6.6V19a1.4 1.4 0 0 1-1.4 1.4H15V15H9v5.4H5.4A1.4 1.4 0 0 1 4 19Z" />
      </svg>
    )
  if (name === 'popular')
    return (
      <svg {...common}>
        <path d="m4 16.5 5.2-5.3 3.4 3.4 6.1-7.4" />
        <path d="M15 7.2h4.5v4.5" />
      </svg>
    )
  if (name === 'shelf')
    return (
      <svg {...common}>
        <path d="M12 3.5 21 8l-9 4.5L3 8Z" />
        <path d="m3 12.5 9 4.5 9-4.5" />
        <path d="m3 16.8 9 4.4 9-4.4" opacity="0.55" />
      </svg>
    )
  if (name === 'adds')
    return (
      <svg {...common}>
        <rect x="4" y="3.6" width="16" height="16.8" rx="2.6" />
        <path d="M8 9h8M8 12.8h8M8 16.6h4.6" />
      </svg>
    )
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 8.3v7.4M8.3 12h7.4" />
    </svg>
  )
}

function Thumb({ item, big = false }: { item: Item; big?: boolean }) {
  return (
    <div className={`thumb ${item.kind}${big ? ' big' : ''}`}>
      {item.hasCover ? (
        <img
          className="item-cover"
          src={coverUrl(item)}
          alt=""
          loading="lazy"
          decoding="async"
        />
      ) : item.kind === 'image' ? (
        <img src={fileUrl(item)} alt="" loading="lazy" decoding="async" />
      ) : (
        <>
          <span className="pdf-glyph" aria-hidden="true">
            PDF
          </span>
          <span className="pdf-lines" aria-hidden="true" />
        </>
      )}
    </div>
  )
}

function SignIn({ status }: { status: Status }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function start() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await signInWithGoogle()
    } catch (e) {
      setError(describeAuthError(e))
      setBusy(false)
    }
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <span className="wordmark">
          <span className="mark" aria-hidden="true" />
          Readshelf
        </span>
        <h1>Sign in to Readshelf.</h1>
        <p className="lede">
          Continue with Google. Your shelf is private to that account, and the
          reads you make public show up on Home.
        </p>

        <button
          type="button"
          className="primary gate-button"
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <ul className="gate-points">
          <li>Private reads stay on your shelf only.</li>
          <li>Public reads take a fair turn on the Home draw.</li>
          <li>“Most opened” ranks public reads by how often they’re opened.</li>
        </ul>
      </div>
    </main>
  )
}

function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [loaded, setLoaded] = useState(false)
  // False until Firebase has reported the restored session (or its absence).
  const [authSettled, setAuthSettled] = useState(false)
  const [view, setView] = useState<View>('home')
  const [feed, setFeed] = useState<Item[]>([])
  const [popular, setPopular] = useState<Item[]>([])
  const [shelf, setShelf] = useState<Item[]>([])
  const [feedState, setFeedState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [reader, setReader] = useState<Item | null>(null)
  // The document whose sharing is being confirmed in the dialog.
  const [pending, setPending] = useState<Item | null>(null)
  const [switching, setSwitching] = useState(false)
  // Selection and deletion in My Adds.
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [sortAsc, setSortAsc] = useState(true)
  const [confirmRemove, setConfirmRemove] = useState<string[] | null>(null)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [file, setFile] = useState<File | null>(null)
  const [cover, setCover] = useState<File | null>(null)
  const [coverPreview, setCoverPreview] = useState('')
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [uploading, setUploading] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )

  const enabled = Boolean(
    loaded && user && status?.database && status.storage,
  )

  // My Adds is alphabetical; the toggle flips the direction.
  const shelfSorted = useMemo(
    () =>
      [...shelf].sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) *
          (sortAsc ? 1 : -1),
      ),
    [shelf, sortAsc],
  )

  useEffect(() => {
    if (!cover) {
      setCoverPreview('')
      return
    }
    const url = URL.createObjectURL(cover)
    setCoverPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [cover])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('readshelf-theme', theme)
    } catch {
      // Storage can be blocked; the theme still applies for this visit.
    }
  }, [theme])

  const loadFeed = useCallback(async () => {
    setFeedState('loading')
    try {
      const result = await request<{ items: Item[] }>('/api/feed')
      setFeed(result.items)
      setFeedState('done')
    } catch (e) {
      setFeedState('done')
      setError(e instanceof Error ? e.message : 'Could not load your feed.')
    }
  }, [])

  const loadShelf = useCallback(async () => {
    try {
      const result = await request<{ items: Item[] }>('/api/items')
      setShelf(result.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your shelf.')
    }
  }, [])

  const loadPopular = useCallback(async () => {
    try {
      const result = await request<{ items: Item[] }>('/api/popular')
      setPopular(result.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the rankings.')
    }
  }, [])

  useEffect(() => {
    let live = true
    let stop: (() => void) | undefined
    void (async () => {
      try {
        const current = await request<Status>('/api/status')
        if (!live) return
        setStatus(current)
        if (current.firebase && current.firebaseConfig) {
          initFirebase(current.firebaseConfig)
          // Firebase reports the restored session (or no session) itself, so a
          // fresh sign-in lands here immediately instead of on a reload.
          stop = watchUser((signedIn) => {
            if (!live) return
            setUser(signedIn)
            setAuthSettled(true)
          })
        } else {
          setAuthSettled(true)
        }
      } catch (e) {
        if (live)
          setError(e instanceof Error ? e.message : 'Could not open Readshelf.')
      } finally {
        if (live) setLoaded(true)
      }
    })()
    return () => {
      live = false
      stop?.()
    }
  }, [])

  // The shell renders as soon as the account is known; the lists fill in after.
  useEffect(() => {
    if (!user || !status?.database || !status.storage) return
    void Promise.all([loadFeed(), loadPopular(), loadShelf()])
  }, [user, status, loadFeed, loadPopular, loadShelf])

  useEffect(() => {
    if (!reader && !pending && !confirmRemove) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setReader(null)
        setPending(null)
        setConfirmRemove(null)
      }
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [reader, pending, confirmRemove])

  async function upload(event: React.FormEvent) {
    event.preventDefault()
    if (!enabled || uploading) return
    if (!file) {
      setError('Choose a PDF or image to add.')
      return
    }
    setUploading(true)
    setError('')
    setNotice('')
    try {
      const form = new FormData()
      form.append('file', file)
      if (cover) form.append('cover', cover)
      if (title.trim()) form.append('title', title.trim())
      form.append('visibility', visibility)
      const result = await request<{ item: Item }>('/api/items', {
        method: 'POST',
        body: form,
      })
      setShelf((current) => [result.item, ...current])
      setFile(null)
      setCover(null)
      setTitle('')
      setView('adds')
      setNotice(
        result.item.visibility === 'public'
          ? 'Added to your shelf and shared publicly.'
          : 'Added to your shelf. It stays off the Home feed.',
      )
      if (result.item.visibility === 'public') void loadFeed()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload that file.')
    } finally {
      setUploading(false)
    }
  }

  async function patch(
    item: Item,
    changes: { visibility?: Visibility },
  ): Promise<boolean> {
    setError('')
    setNotice('')
    try {
      const result = await request<{ item: Item }>(
        `/api/items/${item.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(changes),
        },
      )
      setShelf((current) =>
        current.map((entry) => (entry.id === item.id ? result.item : entry)),
      )
      if (changes.visibility) void loadFeed()
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change sharing.')
      return false
    }
  }

  /** Confirm the flip, then apply it and report the new state. */
  async function confirmSharing() {
    if (!pending) return
    const next: Visibility =
      pending.visibility === 'public' ? 'private' : 'public'
    setSwitching(true)
    const ok = await patch(pending, { visibility: next })
    setSwitching(false)
    setPending(null)
    if (ok)
      setNotice(
        next === 'private'
          ? 'Now private — it stays off the Home feed.'
          : 'Now public — it appears on the Home feed.',
      )
  }

  async function removeMany(ids: string[]) {
    if (!ids.length) return
    setError('')
    setNotice('')
    const failed: string[] = []
    // Sequential on purpose: a bulk delete should not hammer D1 and R2 at once.
    for (const id of ids) {
      try {
        await request(`/api/items/${id}`, { method: 'DELETE' })
      } catch {
        failed.push(id)
      }
    }
    const done = ids.filter((id) => !failed.includes(id))
    if (done.length) {
      const gone = new Set(done)
      setShelf((current) => current.filter((entry) => !gone.has(entry.id)))
      setFeed((current) => current.filter((entry) => !gone.has(entry.id)))
      setPopular((current) => current.filter((entry) => !gone.has(entry.id)))
      setSelected((current) => current.filter((id) => !gone.has(id)))
      if (reader && gone.has(reader.id)) setReader(null)
      setNotice(
        done.length === 1
          ? 'Deleted from your shelf.'
          : `Deleted ${done.length} reads.`,
      )
      if (!failed.length) setSelecting(false)
    }
    if (failed.length)
      setError(
        failed.length === 1
          ? 'One read could not be deleted. Please try again.'
          : `${failed.length} reads could not be deleted. Please try again.`,
      )
  }

  async function runDelete() {
    if (!confirmRemove) return
    setRemoving(true)
    await removeMany(confirmRemove)
    setRemoving(false)
    setConfirmRemove(null)
  }

  /** Keep every list in step with a freshly counted item. */
  function replaceItem(item: Item) {
    const swap = (list: Item[]) =>
      list.map((entry) => (entry.id === item.id ? item : entry))
    setFeed(swap)
    setShelf(swap)
    setPopular(swap)
  }

  function openItem(item: Item) {
    const counted = { ...item, opens: item.opens + 1 }
    setReader(counted)
    replaceItem(counted)
    void request<{ opens: number }>(`/api/items/${item.id}/open`, {
      method: 'POST',
    })
      .then((result) => replaceItem({ ...counted, opens: result.opens }))
      .catch(() => undefined)
  }

  if (!loaded || !authSettled)
    return (
      <main className="gate">
        <div className="gate-card gate-loading">
          <span className="wordmark">
            <span className="mark" aria-hidden="true" />
            Readshelf
          </span>
          <p className="gate-note">Opening your shelf…</p>
        </div>
      </main>
    )

  // A failed status check is not the same as missing storage.
  if (!status)
    return (
      <main className="gate">
        <div className="gate-card">
          <span className="wordmark">
            <span className="mark" aria-hidden="true" />
            Readshelf
          </span>
          <h1>We couldn’t open Readshelf.</h1>
          <p className="lede">
            {error || 'The connection failed. Please try again.'}
          </p>
          <button
            type="button"
            className="button gate-button"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </div>
      </main>
    )

  // Nothing behind the gate renders without a verified Firebase session.
  if (!status.firebase || !user) return <SignIn status={status} />

  return (
    <main>
      <header className="topbar">
        <button
          type="button"
          className="wordmark brand"
          aria-label="Reload Readshelf"
          title="Reload Readshelf"
          onClick={() => window.location.reload()}
        >
          <span className="mark" aria-hidden="true" />
          Readshelf
        </button>
        <nav aria-label="Sections" className="tabs">
          {NAV_ITEMS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={view === key ? 'tab on' : 'tab'}
              aria-current={view === key ? 'page' : undefined}
              onClick={() => {
                setView(key)
                setError('')
                setNotice('')
                if (key === 'home') void loadFeed()
                if (key === 'popular') void loadPopular()
                if (key === 'shelf' || key === 'adds') void loadShelf()
              }}
            >
              <NavIcon name={key} />
              <span className="tab-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="account">
          <button
            type="button"
            className="theme-toggle"
            aria-label={
              theme === 'dark'
                ? 'Switch to light theme'
                : 'Switch to dark theme'
            }
            title={
              theme === 'dark'
                ? 'Switch to light theme'
                : 'Switch to dark theme'
            }
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
          {user && <span className="who">{user.name || user.email}</span>}
          <button
            type="button"
            className="quiet small"
            onClick={async () => {
              await signOut()
              window.location.replace('/')
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {!enabled && loaded && (
        <p className="notice">
          Readshelf is still being set up. Uploading opens shortly.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      {view === 'home' && (
        <section className="page home" aria-labelledby="home-title">
          <h1 id="home-title" className="sr-only">
            Home — public reads
          </h1>

          {feed.length > 0 && (
            <p className="feed-note">
              {feed.length === 1
                ? 'Every public read shows up here.'
                : `All ${feed.length} public reads are here — scroll for more.`}
            </p>
          )}

          {feedState === 'loading' && !feed.length ? (
            <p className="empty">Finding something to read…</p>
          ) : !feed.length ? (
            <div className="empty">
              <span aria-hidden="true">⧉</span>
              <h3>No public reads right now.</h3>
              <p>Add something to your shelf and share it publicly.</p>
            </div>
          ) : (
            <ul className="grid">
              {feed.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="card"
                    onClick={() => openItem(item)}
                  >
                    <Thumb item={item} />
                    <span className="card-title">{item.title}</span>
                    <span className="card-meta">
                      {item.ownerName} · {timeAgo(item.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {view === 'popular' && (
        <section className="page" aria-labelledby="popular-title">
          <div className="page-head">
            <h1 id="popular-title">Most opened</h1>
            <button
              type="button"
              className="quiet small"
              onClick={() => void loadPopular()}
            >
              Refresh
            </button>
          </div>

          {!popular.length ? (
            <div className="empty">
              <span aria-hidden="true">↗</span>
              <h3>No opens recorded yet.</h3>
              <p>Public reads climb this list as readers open them.</p>
            </div>
          ) : (
            <ol className="ranked">
              {popular.map((item, index) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="rank-row"
                    onClick={() => openItem(item)}
                  >
                    <span className="rank" aria-hidden="true">
                      {index + 1}
                    </span>
                    <Thumb item={item} />
                    <span className="rank-body">
                      <span className="rank-title">{item.title}</span>
                      <span className="rank-meta">
                        {item.ownerName} ·{' '}
                        {item.kind === 'pdf' ? 'PDF' : 'Image'}
                      </span>
                    </span>
                    <span className="opens">
                      <strong>{item.opens}</strong>
                      {item.opens === 1 ? 'open' : 'opens'}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {view === 'shelf' && (
        <section className="page" aria-labelledby="shelf-title">
          <div className="page-head">
            <h1 id="shelf-title">My shelf</h1>
          </div>

          {!shelf.length ? (
            <div className="empty">
              <span aria-hidden="true">▤</span>
              <h3>Nothing on the shelf yet.</h3>
              <p>Add a PDF or image — private by default.</p>
            </div>
          ) : (
            <ul className="grid shelf">
              {shelf.map((item) => (
                <li key={item.id} className="shelf-item">
                  <button
                    type="button"
                    className="card"
                    onClick={() => openItem(item)}
                  >
                    <Thumb item={item} />
                    <span className="card-title">{item.title}</span>
                    <span className="card-meta">
                      {item.kind === 'pdf' ? 'PDF' : 'Image'} ·{' '}
                      {formatSize(item.size)} · {item.opens}{' '}
                      {item.opens === 1 ? 'open' : 'opens'}
                    </span>
                    <span className={`pill ${item.visibility}`}>
                      {item.visibility === 'private' ? 'Private' : 'Public'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {view === 'adds' && (
        <section className="page" aria-labelledby="adds-title">
          <div className="page-head">
            <h1 id="adds-title">My Adds</h1>
            <div className="adds-tools">
              {shelf.length ? (
                <button
                  type="button"
                  className="quiet small"
                  title={sortAsc ? 'Sorted A–Z' : 'Sorted Z–A'}
                  aria-label={
                    sortAsc
                      ? 'Sorted A to Z. Switch to Z to A'
                      : 'Sorted Z to A. Switch to A to Z'
                  }
                  onClick={() => setSortAsc((value) => !value)}
                >
                  {sortAsc ? 'A–Z' : 'Z–A'}
                </button>
              ) : null}
              {shelf.length ? <span className="count">{shelf.length}</span> : null}
              {shelf.length ? (
                <button
                  type="button"
                  className={`icon-btn${selecting ? ' on' : ''}`}
                  aria-pressed={selecting}
                  aria-label={
                    selecting ? 'Stop selecting reads' : 'Select reads to delete'
                  }
                  title={selecting ? 'Done selecting' : 'Delete reads'}
                  onClick={() => {
                    setSelecting((value) => !value)
                    setSelected([])
                  }}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.7}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M4.5 7h15" />
                    <path d="M9.5 7V4.9h5V7" />
                    <path d="M6.6 7l.8 12.1h9.2L17.4 7" />
                    <path d="M10.4 10.8v5M13.6 10.8v5" />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>

          <section className="my-adds" aria-labelledby="adds-list-title">
            <h2 id="adds-list-title" className="sr-only">
              Documents you added
            </h2>
            {!shelf.length ? (
              <p className="my-adds-empty">Nothing added yet.</p>
            ) : (
              <>
                <ul className="add-list">
                  {shelfSorted.map((item) => {
                    const picked = selected.includes(item.id)
                    return (
                      <li key={item.id}>
                        {selecting ? (
                          <button
                            type="button"
                            className={`add-row select${picked ? ' on' : ''}`}
                            aria-pressed={picked}
                            aria-label={`Select ${item.title}`}
                            onClick={() =>
                              setSelected((current) =>
                                current.includes(item.id)
                                  ? current.filter((id) => id !== item.id)
                                  : [...current, item.id],
                              )
                            }
                          >
                            <span className="pick" aria-hidden="true">
                              {picked ? '✓' : ''}
                            </span>
                            <Thumb item={item} />
                            <span className="add-body">
                              <span className="add-title">{item.title}</span>
                              <span className="add-meta">
                                {item.kind === 'pdf' ? 'PDF' : 'Image'} ·{' '}
                                {formatSize(item.size)} · {item.opens}{' '}
                                {item.opens === 1 ? 'open' : 'opens'}
                              </span>
                            </span>
                            <span className={`pill ${item.visibility}`}>
                              {item.visibility === 'private'
                                ? 'Private'
                                : 'Public'}
                            </span>
                          </button>
                        ) : (
                          <div className="add-row">
                            <button
                              type="button"
                              className="add-open"
                              aria-label={`Open ${item.title}`}
                              onClick={() => openItem(item)}
                            >
                              <Thumb item={item} />
                              <span className="add-body">
                                <span className="add-title">{item.title}</span>
                                <span className="add-meta">
                                  {item.kind === 'pdf' ? 'PDF' : 'Image'} ·{' '}
                                  {formatSize(item.size)} · {item.opens}{' '}
                                  {item.opens === 1 ? 'open' : 'opens'}
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              className={`pill act ${item.visibility}`}
                              aria-label={`Change sharing for ${item.title}`}
                              title={
                                item.visibility === 'private'
                                  ? 'Make public'
                                  : 'Make private'
                              }
                              onClick={() => setPending(item)}
                            >
                              {item.visibility === 'private'
                                ? 'Private'
                                : 'Public'}
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {selecting && (
                  <div className="select-bar">
                    <span className="select-count">
                      {selected.length} selected
                    </span>
                    <div className="select-actions">
                      <button
                        type="button"
                        className="small danger-fill"
                        disabled={!selected.length || removing}
                        onClick={() => setConfirmRemove(selected)}
                      >
                        Delete selected
                      </button>
                      <button
                        type="button"
                        className="quiet small"
                        disabled={removing}
                        onClick={() =>
                          setConfirmRemove(
                            shelfSorted.map((entry) => entry.id),
                          )
                        }
                      >
                        Delete all
                      </button>
                      <button
                        type="button"
                        className="quiet small"
                        onClick={() => {
                          setSelecting(false)
                          setSelected([])
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </section>
      )}

      {view === 'add' && (
        <section className="page" aria-labelledby="add-title">
          <div className="page-head">
            <h1 id="add-title">Add a read</h1>
          </div>

          <form className="upload" onSubmit={upload}>
            <label className={`drop${file ? ' has-file' : ''}`}>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp,image/gif,image/avif"
                disabled={!enabled || uploading}
                onChange={(e) => {
                  const chosen = e.target.files?.[0] ?? null
                  setFile(chosen)
                  if (chosen && !title)
                    setTitle(chosen.name.replace(/\.[^.]+$/, '').slice(0, 120))
                }}
              />
              {file ? (
                <>
                  <span className="drop-icon" aria-hidden="true">
                    ✓
                  </span>
                  <strong>{file.name}</strong>
                  <span className="drop-hint">
                    {formatSize(file.size)} · tap to choose a different file
                  </span>
                </>
              ) : (
                <>
                  <span className="drop-icon" aria-hidden="true">
                    +
                  </span>
                  <strong>Choose a PDF or image</strong>
                  <span className="drop-hint">
                    PDF, JPEG, PNG, WebP, GIF or AVIF · up to 15 MB
                  </span>
                </>
              )}
            </label>

            <div className="field">
              <span>Cover image</span>
              <div className={`cover-pick${coverPreview ? ' has-cover' : ''}`}>
                <span className="cover-thumb" aria-hidden="true">
                  {coverPreview ? (
                    <img src={coverPreview} alt="" />
                  ) : (
                    <span className="cover-blank">▤</span>
                  )}
                </span>
                <span className="cover-body">
                  <label className="button small cover-button">
                    {cover ? 'Change cover' : 'Add a cover'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                      disabled={!enabled || uploading}
                      onChange={(e) =>
                        setCover(e.target.files?.[0] ?? null)
                      }
                    />
                  </label>
                  {cover ? (
                    <button
                      type="button"
                      className="quiet small"
                      onClick={() => setCover(null)}
                      disabled={uploading}
                    >
                      Remove
                    </button>
                  ) : (
                    <span className="cover-hint">
                      Optional · otherwise the document itself is shown
                    </span>
                  )}
                </span>
              </div>
            </div>

            <label className="field">
              <span>Title</span>
              <input
                type="text"
                maxLength={120}
                value={title}
                disabled={!enabled || uploading}
                placeholder="What is this read called?"
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>

            <fieldset className="field">
              <legend>Who can open it</legend>
              <div className="choices">
                {(['private', 'public'] as const).map((option) => (
                  <label
                    key={option}
                    className={
                      visibility === option ? 'choice on' : 'choice'
                    }
                  >
                    <input
                      type="radio"
                      name="visibility"
                      value={option}
                      checked={visibility === option}
                      disabled={!enabled || uploading}
                      onChange={() => setVisibility(option)}
                    />
                    <strong>
                      {option === 'private' ? 'Private' : 'Public'}
                    </strong>
                    <span>
                      {option === 'private'
                        ? 'Only you can find and open it.'
                        : 'Appears in other readers’ Home feeds.'}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="form-footer">
              <button
                className="primary"
                disabled={!enabled || uploading || !file}
              >
                {uploading ? 'Uploading…' : 'Add to shelf'}
              </button>
              <button
                type="button"
                className="quiet small"
                onClick={() => {
                  setFile(null)
                  setCover(null)
                  setTitle('')
                  setVisibility('private')
                }}
                disabled={uploading}
              >
                Reset
              </button>
            </div>
          </form>
        </section>
      )}

      {pending && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
        >
          <div className="modal-card">
            <h2 id="confirm-title">
              {pending.visibility === 'public'
                ? 'Make it private?'
                : 'Share it publicly?'}
            </h2>
            <p className="modal-text">
              <strong>{pending.title}</strong>{' '}
              {pending.visibility === 'public'
                ? 'will disappear from Home and Most opened. Only you will be able to open it.'
                : 'will appear in other readers’ Home feeds, and anyone signed in can open it.'}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="quiet small"
                onClick={() => setPending(null)}
                disabled={switching}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary small"
                onClick={() => void confirmSharing()}
                disabled={switching}
              >
                {switching
                  ? 'Saving…'
                  : pending.visibility === 'public'
                    ? 'Make private'
                    : 'Make public'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRemove && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-title"
        >
          <div className="modal-card">
            <h2 id="delete-title">
              {confirmRemove.length === 1
                ? 'Delete this read?'
                : `Delete ${confirmRemove.length} reads?`}
            </h2>
            <p className="modal-text">
              {confirmRemove.length === 1
                ? 'This read will be removed'
                : `These ${confirmRemove.length} reads will be removed`}{' '}
              from your shelf, Home and Most opened. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="quiet small"
                onClick={() => setConfirmRemove(null)}
                disabled={removing}
              >
                Cancel
              </button>
              <button
                type="button"
                className="small danger-fill"
                onClick={() => void runDelete()}
                disabled={removing}
              >
                {removing
                  ? 'Deleting…'
                  : confirmRemove.length === 1
                    ? 'Delete'
                    : 'Delete all'}
              </button>
            </div>
          </div>
        </div>
      )}

      {reader && (
        <div
          className="reader"
          role="dialog"
          aria-modal="true"
          aria-label={reader.title}
        >
          <div className="reader-bar">
            <div>
              <p className="reader-title">{reader.title}</p>
              <p className="reader-meta">
                {reader.isOwner
                  ? reader.visibility === 'private'
                    ? 'Private · only you'
                    : 'Public'
                  : reader.ownerName}
                {' · '}
                {reader.opens} {reader.opens === 1 ? 'open' : 'opens'}
              </p>
            </div>
            <div className="reader-actions">
              <a
                className="button small"
                href={fileUrl(reader)}
                target="_blank"
                rel="noreferrer"
              >
                {reader.kind === 'pdf' ? 'Open PDF' : 'Open image'}
              </a>
              <button
                type="button"
                className="quiet small"
                onClick={() => setReader(null)}
              >
                Close
              </button>
            </div>
          </div>
          <div className="reader-body">
            {reader.kind === 'pdf' ? (
              <iframe
                src={fileUrl(reader)}
                title={reader.title}
                className="reader-frame"
              />
            ) : (
              <img
                className="reader-image"
                src={fileUrl(reader)}
                alt={reader.title}
              />
            )}
          </div>
        </div>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
