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

Open the URL printed by Vite. Sign-in needs a Firebase web app (below); until
the three `FIREBASE_*` values are set the gate lists the exact steps.

## Sign-in with Firebase

1. In the [Firebase console](https://console.firebase.google.com) create a
   project (Google Analytics is not needed).
2. **Authentication → Get started → Sign-in method → Google**, enable it and
   pick a support email. This creates the Google OAuth client for you.
3. **Project settings → Your apps → Web (`</>`)** — register the app and copy
   `apiKey`, `authDomain`, `projectId` and `appId`.
4. **Authentication → Settings → Authorized domains**: `localhost` is allowed
   by default; add your deployed domain.

Then, locally:

```
FIREBASE_API_KEY=AIzaSy...
FIREBASE_PROJECT_ID=readshelf-1234
FIREBASE_APP_ID=1:1234567890:web:abcdef123456
FIREBASE_AUTH_DOMAIN=readshelf-1234.firebaseapp.com
```

Put them in `.dev.vars` (gitignored) and restart the dev server. These are
public web-app values, not an admin key: no service account, private key or
secret is involved. Nothing is sent to a third-party auth API at request time —
the Worker validates the token signature locally and checks `aud` (project id),
`iss`, `exp`, `iat` and the verified email.

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
3. Set `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID` and `FIREBASE_APP_ID` (and
   `FIREBASE_AUTH_DOMAIN` if it is not `<project>.firebaseapp.com`) as project
   secrets.
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
