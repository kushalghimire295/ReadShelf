# Readshelf

A reading shelf for PDFs and images, with Google sign-in through Firebase. Each
signed-in reader has their own shelf; public reads are shared on the Home feed.

- **Private** — only its owner can list, open or download it. Anyone else gets
  the same 404 as for a missing read.
- **Public** — enters the Home draw, which shows each read a fair share of the
  time (two public reads: 50% each, and over many visits each appears half).
- **Most opened** — an all-time ranking of public reads by how often they were
  opened; private reads are neither counted nor listed there.
- **Covers** — a separate cover image can be uploaded with a document and is
  used on every card and row instead of the document preview.
- **Sign-in** — Google through Firebase Authentication. The browser signs in
  with the Firebase SDK; the Worker verifies the resulting Firebase ID token
  itself (RS256 against Google's published signing keys) before returning any
  data, and rows are scoped by the Firebase uid.
- Files live in R2 (`FILES`); titles, sharing, counters live in D1 (`DB`).

## Start and check

```sh
bun install
bun run dev
bun test
bun run typecheck
bun run build
```

Open the URL printed by Vite. Google sign-in works with no setup: the public
Firebase web config (project `readshelf-1ca03`) is built into
`src/worker/firebase.ts` and served to the browser by `/api/status`.

## Sign-in with Firebase

Google sign-in is the only identity provider. The browser signs in with the
Firebase SDK and sends the ID token; the Worker verifies it itself.

The project is `readshelf-1ca03` — **Authentication → Sign-in method → Google**
is enabled, and `localhost` is an authorized domain. To host elsewhere, add that
domain under **Authentication → Settings → Authorized domains**.

These values are public web-app settings, not an admin key: no service account,
private key or secret is involved, so they are committed rather than configured
per environment. To point the site at a different Firebase project, set
`FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` and (optionally)
`FIREBASE_AUTH_DOMAIN` in `.dev.vars` or as project secrets; they override the
built-in ones.

Nothing is sent to a third-party auth API at request time — the Worker
validates the token signature against Google's published keys and checks `aud`
(project id), `iss`, `exp`, `iat` and the verified email.

## Where things live

- `src/client/main.tsx` — the sign-in gate, Home feed, Most opened, My shelf,
  My Adds, the upload form, the reader overlay and the light/dark theme.
- `src/client/firebase.ts` — the Firebase browser SDK: Google popup sign-in,
  restored sessions, ID token refresh, sign-out.
- `src/worker/firebase.ts` — public Firebase config plus ID token verification
  against `securetoken@system.gserviceaccount.com`'s published keys, cached per
  token and key set.
- `src/worker/app.ts` — API routes and the guard that verifies identity.
- `src/worker/db.ts` — the D1 `items` table, `app_meta` and row mapping.
- `src/shared/types.ts` — API types shared by browser and server.

### API

Every shelf route needs `Authorization: Bearer <Firebase ID token>` and answers
401 without a verifiable one.

| Route | Purpose |
| --- | --- |
| `GET /api/status` | bindings and the public Firebase web settings |
| `GET /api/me` | the signed-in reader, or `null` |
| `GET /api/feed` | the Home draw of public reads, with its percentage |
| `GET /api/items` | your own shelf |
| `POST /api/items` | multipart upload: `file`, optional `cover`, `title`, `visibility` |
| `PATCH /api/items/:id` | rename or change visibility (owner only) |
| `DELETE /api/items/:id` | remove the row and stored objects (owner only) |
| `GET /api/items/:id/file` | inline PDF/image stream, access-checked |
| `GET /api/items/:id/cover` | the uploader's cover image, same rules |
| `POST /api/items/:id/open` | record one open and return the new total |
| `GET /api/popular` | all-time ranking of public reads by opens |

Uploads accept PDF, JPEG, PNG, WebP, GIF and AVIF up to 15 MB. A cover must be
an image of up to 5 MB. Titles are 1–120 characters. All queries bind parameters
and scope ownership by the verified uid; mutations reject foreign origins.

## Publish

1. Create/inspect the site and target preview first.
2. `sites_add_storage` for D1 as `DB` **and** R2 as `FILES`.
3. No Firebase secrets to set: the web config is built in. Add the deployed
   origin under Firebase's authorized domains.
4. Add the deployed origin to Firebase's authorized domains.
5. Build and deploy with `sites_deploy` and `deploy.json`.

Documents uploaded before sign-in existed are adopted by the first account that
signs in, so an existing shelf is not stranded.

## Verify before publishing

`bun test` runs against real local D1 and R2 through Miniflare: upload bytes
round-trip, private reads stay owner-only, public reads reach other readers,
only an owner can rename or delete, opens are ranked for public reads only,
covers are access-checked, the Home percentage holds over many visits, and a
Firebase ID token is accepted only when its signature, project, issuer and
expiry all check out.
