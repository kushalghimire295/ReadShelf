# Readshelf

A reading shelf for PDFs and images. Each signed-in reader keeps a private
shelf; anything they mark public is shown to other readers on the Home feed.

- **Private** — only the owner can list, open or download it. Other people get
  the same 404 as for a missing item, so nothing leaks.
- **Most opened** — an all-time ranking of public reads by how many times
  they have been opened. Private items are neither counted nor listed there,
  and only readers allowed to open an item can increment it.
- **Public** — appears on every other reader's Home feed, newest first. Private
  reads never appear there.
- **Sign-in** — passwordless. A six-digit code by email, or Google. The first
  sign-in creates the account; there are no passwords to store.
- **Covers** — a separate cover image can be uploaded with a document, and
  that image is used on every card and row instead of the document preview.
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

Open the URL printed by Vite. The server binds to `0.0.0.0` and runs the Worker
with local D1 and R2 bindings. Sign-in codes are only ever delivered by email,
so a local run needs an email provider key (see below) before anyone can sign
in. Documents uploaded before sign-in existed belong to the `local-preview`
owner and are adopted by the first sign-in on that machine.

## Where things live

- `src/client/main.tsx` — the full-page sign-in gate, Home feed, Most opened,
  My shelf, upload form, reader overlay and the light/dark theme switch.
  Signed out, only the gate renders; the development identity bypasses it.
- `src/client/style.css` — responsive layout: 2-up cards on phones, a wider
  auto-fill grid from tablet up.
- `src/worker/app.ts` — `/api/auth/*` routes plus `/api/feed`, `/api/items`
  CRUD, `/api/items/:id/file` and `/api/items/:id/cover`.
- `src/worker/auth.ts` — email one-time codes, Google OAuth, and the signed
  HttpOnly session cookie stored in D1 (`users`, `login_codes`, `sessions`).
- `src/worker/db.ts` — the D1 `items` table and row mapping.
- `src/shared/types.ts` — API types shared by browser and server.

### API

| Route | Purpose |
| --- | --- |
| `GET /api/session` | current user, plus which sign-in methods are available |
| `POST /api/auth/email` | send (or locally show) a six-digit sign-in code |
| `POST /api/auth/email/verify` | exchange the code for a session cookie |
| `GET /api/auth/google` | start Google OAuth |
| `GET /api/auth/google/callback` | finish Google OAuth and set the session |
| `POST /api/auth/signout` | revoke the session and clear the cookie |
| `GET /api/feed` | public items from other readers, newest first |
| `GET /api/items` | your own shelf (private and public) |
| `POST /api/items` | multipart upload: `file`, optional `cover`, `title`, `visibility` |
| `PATCH /api/items/:id` | rename or change visibility |
| `DELETE /api/items/:id` | remove the row and the stored object |
| `GET /api/items/:id/file` | inline PDF/image stream, authorised per request |
| `GET /api/items/:id/cover` | the uploader's cover image, same access rules |
| `POST /api/items/:id/open` | record one open and return the new total |
| `GET /api/popular` | all-time ranking of public reads by opens |

Uploads accept PDF, JPEG, PNG, WebP, GIF and AVIF up to 15 MB. A cover must be
an image (JPEG, PNG, WebP, GIF or AVIF) of up to 5 MB. Titles are 1–120
characters. All queries bind parameters and scope ownership by the
authenticated user's `sub`; mutations reject foreign origins.

## Sign-in configuration

Sign-in is part of the Worker; there is no third-party auth service.

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | 32+ random characters. Signs session cookies. Required on any non-loopback origin. |
| `RESEND_API_KEY` | Resend API key used to deliver email codes. |
| `SENDGRID_API_KEY` | Alternative to Resend; used when Resend is unset. |
| `EMAIL_FROM` | Verified sender, e.g. `Readshelf <hello@yourdomain>`. |
| `GOOGLE_CLIENT_ID` | Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `APP_ORIGIN` | Canonical public origin, also the base for the Google redirect. |

Register `<APP_ORIGIN>/api/auth/google/callback` as the Google redirect URI.
Codes are never returned to the browser: with a provider key and `EMAIL_FROM`
the six-digit code is emailed and nothing is shown on screen. Without them the
request is refused with “Email sign-in is not set up yet”, on every origin.

## Publish

1. Create/inspect the site and target preview first.
2. `sites_add_storage` for D1 as `DB` **and** R2 as `FILES`.
3. Set the variables above as project secrets/variables.
4. Build and deploy with `sites_deploy` and `deploy.json`.

## Verify before publishing

`bun test` runs against real local D1 and R2 through Miniflare: upload bytes
round-trip, private items stay owner-only (including the file route), public
items surface in other feeds, sharing changes take effect, opens are counted and
ranked while private items stay out of the ranking, covers are stored, served and
access-checked, email codes create a session that sign-out revokes, and
signed-out/foreign-origin/oversized requests are refused. After provisioning, verify real sign-in, refresh, sign-out
and two accounts' isolation in a browser.
