# Readshelf

A reading shelf for PDFs and images, with Google sign-in through Supabase. Each
reader keeps a private shelf; anything they mark public takes a turn on the
Home feed.

- **Sign-in** — Supabase Auth with the Google provider. The browser keeps the
  session; the Worker verifies its access token with Supabase before returning
  any shelf data, and rows are scoped by the Supabase user id.
- **Private** — only its owner can list, open or delete it. Other readers get
  the same 404 as for a missing item.
- **Home** — a draw, not a list. Each public read's chance is 1 in the total
  number of public reads, and `items.shown` records how often it has already
  been drawn, so the least-shown goes first. Ten visits with two public reads
  show each one five times: the percentage on screen is a long-run guarantee.
- **Most opened** — an all-time ranking of public reads by opens; private reads
  are neither counted nor listed there.
- **Covers** — a separate cover image can be uploaded with a document, and that
  image is used on every card and row instead of the document preview.
- Files live in R2 (`FILES`); titles, sharing and cover references live in D1
  (`DB`).

## Start and check

```sh
bun install
bun run dev
bun test
bun run typecheck
bun run build
```

Open the URL printed by Vite. Sign-in needs a Supabase project (below); until
`SUPABASE_URL` and `SUPABASE_ANON_KEY` are set the gate lists the exact steps.

## Sign-in with Supabase

1. Create a project at supabase.com, then **Authentication → Providers →
   Google**: enable it and paste a Google OAuth client id and secret from
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   (create a *Web application* client first).
2. In Google's client, add the Supabase callback as an authorised redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. In Supabase **Authentication → URL Configuration**, set the site URL and add
   `http://localhost:5174` and your deployed origin as redirect URLs.
4. Put the project values in `.dev.vars` (local) or project secrets (deployed):

```sh
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<the anon public key>
```

Restart the dev server. The gate's **Continue with Google** opens Google's
account picker, and the callback returns to the app with a session.

`SUPABASE_ANON_KEY` is the public anon key, never the service-role key: it only
identifies the project, while the reader's access token identifies the user and
is verified server-side on every data request.

## Where things live

- `src/client/main.tsx` — sign-in gate, Home feed, Most opened, My shelf, My
  Adds, the upload form, the reader overlay and the light/dark theme switch.
- `src/client/supabase.ts` — the browser Supabase client: Google sign-in,
  session persistence, and the access token the API calls carry.
- `src/client/style.css` — responsive layout: 2-up cards on phones, a wider
  auto-fill grid from tablet up.
- `src/worker/app.ts` — the guarded API: `/api/status`, `/api/me`, `/api/feed`,
  `/api/items` CRUD, files and covers.
- `src/worker/supabase.ts` — access-token verification against
  `<SUPABASE_URL>/auth/v1/user`, cached for a minute per token.
- `src/worker/db.ts` — the D1 `items` table and row mapping.
- `src/shared/types.ts` — API types shared by browser and server.

### API

Every shelf route needs `Authorization: Bearer <supabase access token>` and
answers 401 without one.

| Route | Purpose |
| --- | --- |
| `GET /api/status` | database/bucket bindings and the public Supabase settings |
| `GET /api/me` | the verified reader, or `null` |
| `GET /api/feed` | the Home draw: `items`, `chance`, `total` |
| `GET /api/items` | your own shelf |
| `POST /api/items` | multipart upload: `file`, optional `cover`, `title`, `visibility` |
| `PATCH /api/items/:id` | rename or change visibility (owner only) |
| `DELETE /api/items/:id` | remove the row and the stored object (owner only) |
| `GET /api/items/:id/file` | inline PDF/image stream (public or owner) |
| `GET /api/items/:id/cover` | the uploader's cover image, same rules |
| `POST /api/items/:id/open` | record one open and return the new total |
| `GET /api/popular` | all-time ranking of public reads by opens |

Uploads accept PDF, JPEG, PNG, WebP, GIF and AVIF up to 15 MB. A cover must be
an image of up to 5 MB. Titles are 1–120 characters. All queries bind
parameters and scope ownership by the verified user's id; mutations reject
foreign origins.

## Publish

1. Create/inspect the site and target preview first.
2. `sites_add_storage` for D1 as `DB` **and** R2 as `FILES`.
3. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as site secrets and add the
   deployed origin to Supabase's redirect URLs.
4. Build and deploy with `sites_deploy` and `deploy.json`.

## Verify before publishing

`bun test` runs against real local D1 and R2 through Miniflare: the status route
is public while every shelf route refuses an unauthenticated caller, Supabase
tokens are verified against the project, private reads stay with their owner,
public reads reach other readers, ownership gates rename/delete/covers, the Home
percentage holds exactly over forty visits, and foreign-origin and oversized
uploads are refused.
