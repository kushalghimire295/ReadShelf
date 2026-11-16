import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Item, Session, Visibility } from '../shared/types'
import './style.css'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => {
    throw new Error('Could not reach Readshelf. Please try again.')
  })) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'The request failed. Please try again.')
  return body
}

const fileUrl = (item: Item) => `/api/items/${item.id}/file`

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

type View = 'home' | 'popular' | 'shelf' | 'add'

const NAV_ITEMS: { key: View; label: string }[] = [
  { key: 'home', label: 'Home' },
  { key: 'popular', label: 'Most opened' },
  { key: 'shelf', label: 'My shelf' },
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
      {item.kind === 'image' ? (
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

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<View>('home')
  const [feed, setFeed] = useState<Item[]>([])
  const [popular, setPopular] = useState<Item[]>([])
  const [shelf, setShelf] = useState<Item[]>([])
  const [feedState, setFeedState] = useState<'idle' | 'loading' | 'done'>('idle')
  const [reader, setReader] = useState<Item | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [uploading, setUploading] = useState(false)
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )

  const enabled = Boolean(
    loaded && session?.user && session.database && session.storage,
  )

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
    void (async () => {
      try {
        const current = await request<Session>('/api/session')
        if (!live) return
        setSession(current)
        if (current.user && current.database && current.storage) {
          await Promise.all([loadFeed(), loadPopular(), loadShelf()])
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
    }
  }, [loadFeed, loadPopular, loadShelf])

  useEffect(() => {
    if (!reader) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReader(null)
    }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [reader])

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
      if (title.trim()) form.append('title', title.trim())
      form.append('visibility', visibility)
      const result = await request<{ item: Item }>('/api/items', {
        method: 'POST',
        body: form,
      })
      setShelf((current) => [result.item, ...current])
      setFile(null)
      setTitle('')
      setView('shelf')
      setNotice(
        result.item.visibility === 'public'
          ? 'Added to your shelf and shared publicly.'
          : 'Added to your shelf. Only you can open it.',
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
  ) {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change sharing.')
    }
  }

  async function remove(item: Item) {
    setError('')
    try {
      await request(`/api/items/${item.id}`, { method: 'DELETE' })
      setShelf((current) => current.filter((entry) => entry.id !== item.id))
      setFeed((current) => current.filter((entry) => entry.id !== item.id))
      setPopular((current) => current.filter((entry) => entry.id !== item.id))
      if (reader?.id === item.id) setReader(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete that item.')
    }
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

  if (!loaded)
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

  // A failed session check is not the same as being signed out.
  if (!session)
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

  // The app is gated: nothing behind it renders until someone is signed in.
  if (!session.user)
    return (
      <main className="gate">
        <div className="gate-card">
          <span className="wordmark">
            <span className="mark" aria-hidden="true" />
            Readshelf
          </span>
          <h1>Your shelf, on every device.</h1>
          <p className="lede">
            Keep PDFs and images private, or share them with other readers.
            Sign in to start your shelf.
          </p>
          {session.mode === 'freebuff' ? (
            <a
              className="button gate-button"
              href="/auth/freebuff/signin?returnTo=%2F"
            >
              Sign in with Freebuff
            </a>
          ) : (
            <p className="gate-note">
              Sign-in isn’t connected yet. It becomes available once this app is
              published with an account provider.
            </p>
          )}
          <p className="gate-note">
            No new password to remember — you’ll continue with Google, GitHub
            or Apple through Freebuff, and your first sign-in creates the
            account.
          </p>
          <ul className="gate-points">
            <li>Private by default — only you can open your own files.</li>
            <li>Public reads can surface on other readers’ Home feeds.</li>
            <li>
              “Most opened” ranks public reads by how often they’re opened.
            </li>
          </ul>
        </div>
      </main>
    )

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
                if (key === 'shelf' || key === 'add') void loadShelf()
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
          <form method="post" action="/auth/freebuff/signout">
            <button className="quiet small">Sign out</button>
          </form>
        </div>
      </header>

      {!enabled && loaded && (
        <p className="notice">
          {session && (!session.database || !session.storage)
            ? 'Readshelf is still being set up. Uploading opens shortly.'
            : 'Sign in with Freebuff to keep your own shelf.'}
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
                    <span
                      className={`pill ${item.visibility}`}
                    >
                      {item.visibility === 'private' ? 'Private' : 'Public'}
                    </span>
                  </button>
                  <div className="share">
                    <div className="seg" role="group" aria-label={`Sharing for ${item.title}`}>
                      {(['private', 'public'] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={
                            item.visibility === option ? 'seg-btn on' : 'seg-btn'
                          }
                          onClick={() => void patch(item, { visibility: option })}
                        >
                          {option === 'private' ? 'Private' : 'Public'}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="quiet small danger"
                      onClick={() => void remove(item)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {view === 'add' && (
        <section className="page" aria-labelledby="add-title">
          <div className="page-head">
            <h1 id="add-title">Add a read</h1>
          </div>

          <section className="my-adds" aria-labelledby="my-adds-title">
            <div className="my-adds-head">
              <h2 id="my-adds-title">My Adds</h2>
              {shelf.length ? <span>{shelf.length}</span> : null}
            </div>
            {!shelf.length ? (
              <p className="my-adds-empty">Nothing added yet.</p>
            ) : (
              <ul className="add-list">
                {shelf.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="add-row"
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
                      <span className={`pill ${item.visibility}`}>
                        {item.visibility === 'private' ? 'Private' : 'Public'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

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
