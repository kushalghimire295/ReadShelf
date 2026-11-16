# Readshelf

A reading shelf for PDFs and images. Each signed-in reader keeps a private
shelf; anything they mark public is shown to other readers on the Home feed.

- **Private** — only the owner can list, open or download it. Other people get
  the same 404 as for a missing item, so nothing leaks.
- **Most opened** — an all-time ranking of public reads by how many times
  they have been opened. Private items are neither counted nor listed there,
  and only readers allowed to open an item can increment it.
- **Public** — appears on other readers' Home feeds with a chosen *reach*
  percentage (10–100). Each Home refresh includes the item with that
  probability, so "25%" means roughly one feed in four.
- Files live in R2 (`FILES`); titles, sharing and reach live in D1 (`DB`).

## Start and check

```sh
bun install
bun run dev
bun test
bun run typecheck
bun run build
```

Open the URL printed by Vite. The server binds to `0.0.0.0` and runs the Worker
with local D1 and R2 bindings. With no auth configuration on a loopback origin,
a single local development identity is used. That fallback never applies on a
hosted origin or with incomplete auth config, and the interface does not label
it — locally the app simply opens as a signed-in reader named “Reader”.

## Where things live

- `src/client/main.tsx` — the full-page sign-in gate, Home feed, Most opened,
  My shelf, upload form, reader overlay and the light/dark theme switch.
  Signed out, only the gate renders; the development identity bypasses it.
- `src/client/style.css` — responsive layout: 2-up cards on phones, a wider
  auto-fill grid from tablet up.
- `src/worker/app.ts` — `/api/feed`, `/api/items` CRUD and `/api/items/:id/file`.
- `src/worker/db.ts` — the D1 `items` table and row mapping.
- `src/shared/types.ts` — API types shared by browser and server.

### API

| Route | Purpose |
| --- | --- |
| `GET /api/session` | current user, auth mode, database + storage readiness |
| `GET /api/feed` | public items from other readers, sampled by reach |
| `GET /api/items` | your own shelf (private and public) |
| `POST /api/items` | multipart upload: `file`, `title`, `visibility`, `reach` |
| `PATCH /api/items/:id` | rename, change visibility or reach |
| `DELETE /api/items/:id` | remove the row and the stored object |
| `GET /api/items/:id/file` | inline PDF/image stream, authorised per request |
| `POST /api/items/:id/open` | record one open and return the new total |
| `GET /api/popular` | all-time ranking of public reads by opens |

Uploads accept PDF, JPEG, PNG, WebP, GIF and AVIF up to 15 MB. Titles are
1–120 characters. All queries bind parameters and scope ownership by the
authenticated user's `sub`; mutations reject foreign origins.

## Publish with Freebuff

1. Create/inspect the site and target preview first.
2. `sites_enable_auth` (Sign in with Freebuff). For local login testing use the
   dev server's loopback origin and only the returned development variables.
3. `sites_add_storage` for D1 as `DB` **and** R2 as `FILES`.
4. Build and deploy with `sites_deploy` and `deploy.json`.

Sites injects `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and `APP_ORIGIN`. No
application secret or separate cloud account is needed.

## Verify before publishing

`bun test` runs against real local D1 and R2 through Miniflare: upload bytes
round-trip, private items stay owner-only (including the file route), public
items surface in other feeds, reach 0 hides an item from feeds, sharing changes
take effect, opens are counted and ranked while private items stay out of the
ranking, deletion removes the row, and signed-out/foreign-origin/oversized
requests are refused. After provisioning, verify real sign-in, refresh, sign-out
and two accounts' isolation in a browser.
