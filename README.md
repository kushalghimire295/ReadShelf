# Readshelf

A reading shelf for PDFs and images. No accounts, no sign-in: whoever opens the
app works with one shelf.

- **Private** — kept off the Home feed and the ranking, but still on your shelf
  and openable from there.
- **Public** — appears on the Home feed, newest first.
- **Most opened** — an all-time ranking of public reads by how many times they
  have been opened; private reads are neither counted nor listed there.
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
with local D1 and R2 bindings, so there is nothing to configure before use.

## Where things live

- `src/client/main.tsx` — Home feed, Most opened, My shelf, My Adds, the upload
  form, the reader overlay and the light/dark theme switch.
- `src/client/style.css` — responsive layout: 2-up cards on phones, a wider
  auto-fill grid from tablet up.
- `src/worker/app.ts` — `/api/status` plus `/api/feed`, `/api/items` CRUD,
  `/api/items/:id/file` and `/api/items/:id/cover`.
- `src/worker/db.ts` — the D1 `items` table and row mapping.
- `src/shared/types.ts` — API types shared by browser and server.

### API

| Route | Purpose |
| --- | --- |
| `GET /api/status` | whether the database and bucket bindings are present |
| `GET /api/feed` | public reads, newest first |
| `GET /api/items` | everything on the shelf |
| `POST /api/items` | multipart upload: `file`, optional `cover`, `title`, `visibility` |
| `PATCH /api/items/:id` | rename or change visibility |
| `DELETE /api/items/:id` | remove the row and the stored object |
| `GET /api/items/:id/file` | inline PDF/image stream |
| `GET /api/items/:id/cover` | the uploader's cover image |
| `POST /api/items/:id/open` | record one open and return the new total |
| `GET /api/popular` | all-time ranking of public reads by opens |

Uploads accept PDF, JPEG, PNG, WebP, GIF and AVIF up to 15 MB. A cover must be
an image (JPEG, PNG, WebP, GIF or AVIF) of up to 5 MB. Titles are 1–120
characters. All queries bind parameters; mutations reject foreign origins.

## Publish

1. Create/inspect the site and target preview first.
2. `sites_add_storage` for D1 as `DB` **and** R2 as `FILES`.
3. Build and deploy with `sites_deploy` and `deploy.json`.

## Verify before publishing

`bun test` runs against real local D1 and R2 through Miniflare: upload bytes
round-trip, public reads surface in the feed, private reads stay out of it while
remaining on the shelf, sharing changes take effect, opens are counted and
ranked, covers are stored, served and optional, and foreign-origin, oversized
and missing-storage requests are refused.
