# Escort Chart

A table-assignment tool for events held in flexible spaces — venues with
tables and chairs of different sizes and shapes, not fixed seat maps. You
place *parties* (ticket purchasers, grouped by who wants to sit together)
onto tables within front/middle/back sections, upload and re-upload a guest
list CSV without losing manual seating work, and share a single event's
chart with a private link.

## What it does

- **Venues** are reusable table layouts (e.g. "Concannon Vineyard — Barrel
  Room"), each with its own set of tables — round, square, or rectangular,
  any capacity — grouped into Front / Middle / Back sections.
- **Events** belong to one venue and hold one guest list + seating chart.
  Each event gets a long, unguessable link (`/e/<share-slug>`) that's the
  *only* way in — there's no login. Share that one link and the recipient
  only ever sees that event, never your other venues or events. The
  dashboard (`/`) that lists everything is a separate, unshared URL.
- **Guest list upload**: paste or upload a CSV with guest name, party size,
  party name (who they want to sit with), and a placement preference
  (front / middle / back / no preference). Re-uploading **reconciles**
  against what's already seated — a party still in the new CSV keeps its
  table; a party that's gone is deactivated (seats freed, history kept);
  a new party shows up unassigned.
- **Hard section requirement**: a party with an explicit Front/Middle/Back
  preference is *only ever* placed in that section by auto-assign. If
  nothing fits there, it's left unassigned with an explanation — it never
  gets bumped to another section. Parties with no preference fill
  Front → Middle → Back.
- **Split first, then move**: click "Split…" on any party to divide it into
  pieces (e.g. 14 → 6 and 8) before placing them — then drag each piece
  independently onto any table or back to the unassigned tray.
- **Export**: a CSV download and a printable per-table view, both scoped to
  one event.

## Tech stack

- **Next.js 16** (App Router, Server Actions) — no separate API layer.
- **Drizzle ORM** + `pg` against Postgres. (Prisma was tried first but its
  install fetches a native engine binary from `binaries.prisma.sh`, which
  this sandbox's network policy blocked outright — Drizzle is pure
  TypeScript and needed nothing beyond `npm install`. Either would work
  fine in a normal environment; this is just why Drizzle is what shipped.)
- **Tailwind CSS v4** (CSS-first config, see `src/app/globals.css`).
- Fonts (Fraunces / Public Sans / IBM Plex Mono) are self-hosted via
  `@fontsource/*` packages rather than `next/font/google`, so the build
  never makes an external request to Google Fonts.

## Local development

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Point it at a Postgres database.** Any Postgres 14+ works — local,
   Docker, or a free cloud instance.

   ```bash
   cp .env.example .env.local
   # edit .env.local and set DATABASE_URL
   ```

3. **Run migrations**

   ```bash
   npm run db:migrate
   ```

4. **Start the dev server**

   ```bash
   npm run dev
   ```

   Visit `http://localhost:3000` — that's the dashboard. Create a venue,
   add tables, create an event under it, and you're off.

5. **Run the unit tests** (pure logic only — CSV parsing, the auto-assign
   engine, and CSV-reconciliation — no database needed):

   ```bash
   npm test
   ```

### Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build / run |
| `npm run db:generate` | Generate a new SQL migration from `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:push` | Push schema straight to the DB without a migration file (handy for quick local iteration) |
| `npm run db:studio` | Open Drizzle Studio, a GUI for browsing the database |
| `npm test` | Run the unit tests |

## Running with Docker

This is the easiest way to try it out locally, and the path used for
deploying to a Hostinger VPS below. It packages the app **and** a Postgres
database together — nothing to install beyond Docker itself.

1. **Copy the env file** (this configures the database credentials and the
   host port Docker Compose uses — separate from `.env.local`, which is
   only for `npm run dev` outside Docker):

   ```bash
   cp .env.docker.example .env
   # edit .env — at minimum, change POSTGRES_PASSWORD
   ```

2. **Build and start everything:**

   ```bash
   docker compose up -d --build
   ```

   This builds the app image, starts Postgres, waits for it to be healthy,
   runs migrations automatically (see `docker-entrypoint.sh`), then starts
   the app. First run takes a couple of minutes; after that, `docker
   compose up -d` is fast.

3. Visit `http://localhost:3000` (or whatever `APP_PORT` you set).

Useful commands:

| Command | What it does |
| --- | --- |
| `docker compose up -d --build` | Build (if needed) and start everything in the background |
| `docker compose logs -f app` | Follow the app's logs |
| `docker compose down` | Stop everything (data persists in a Docker volume) |
| `docker compose down -v` | Stop everything **and delete the database volume** |
| `docker compose up -d --build` (again) | Rebuild after a code change and redeploy — migrations re-run automatically, so a schema change just needs a new migration file (`npm run db:generate` locally, commit it) before this |

## Deploying to a Hostinger VPS

Hostinger's VPS plans include a **Docker Manager** in hPanel that runs a
`docker-compose.yml` for you — no manual Docker CLI setup on the server
needed. ([Hostinger's Docker Manager docs](https://www.hostinger.com/support/12040789-hostinger-docker-manager-for-vps-simplify-your-container-deployments/), [first-container walkthrough](https://www.hostinger.com/support/12040815-how-to-deploy-your-first-container-with-hostinger-docker-manager/))

1. **Get a Hostinger VPS** with the Docker template/OS option (KVM plans
   support this).
2. **Push this project to a Git repository** (GitHub/GitLab) — Docker
   Manager can deploy straight from a repo URL, or you can paste the
   compose file manually.
3. In hPanel, go to **VPS → Manage → Docker Manager → Compose**, and either:
   - **Compose from URL** — point it at this repo's `docker-compose.yml`, or
   - **Compose Manually** — paste the contents of `docker-compose.yml`.
4. **Set environment variables** in the Docker Manager UI (same values as
   `.env.docker.example`): `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   `POSTGRES_DB`. Use a real password, not the example one.
5. **Deploy.** Docker Manager builds and starts both containers. You'll be
   able to reach the app at `http://your-vps-ip:3000` (or whatever port you
   mapped) right away — good enough to try it out.
6. **For a real domain with HTTPS**, add a reverse proxy in front of the
   app rather than exposing port 3000 directly. The included
   `docker-compose.prod.yml` adds [Caddy](https://caddyserver.com), which
   handles Let's Encrypt certificates automatically:

   ```bash
   cp Caddyfile.example Caddyfile
   # edit Caddyfile — replace your-domain.com with your real domain,
   # which must already have an A record pointing at the VPS's IP
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```

   (If deploying through the Docker Manager UI instead of the CLI, paste
   the merged result of both compose files, or run this `docker compose`
   command over SSH on the VPS — Hostinger VPS plans include SSH access.)

### Alternative: Vercel + managed Postgres

If you'd rather not run your own server, this also deploys to
**Vercel + a managed Postgres provider** (Vercel Postgres,
[Neon](https://neon.tech), or [Supabase](https://supabase.com) — any of
them just needs a connection string), without Docker at all:

1. **Push this project to a Git repository** and import it into Vercel
   ("Add New… → Project").
2. **Create a Postgres database** with your chosen provider and copy its
   connection string.
3. **Set environment variables** in the Vercel project settings:
   - `DATABASE_URL` — the connection string from step 2.
   - `DATABASE_SSL=true` — managed Postgres providers require SSL; this
     flag turns it on (see `src/db/index.ts`).
4. **Run the migration against the production database** once, from your
   machine, before (or right after) the first deploy: temporarily put the
   production `DATABASE_URL` (and `DATABASE_SSL=true`) in `.env.local` and
   run `npm run db:migrate`, then put your local values back.
5. **Deploy.** Vercel will build and serve it.

### Future schema changes

Whichever path you use: edit `src/db/schema.ts`, run `npm run db:generate`
to create a migration file, and commit it. With Docker, the next `docker
compose up -d --build` applies it automatically. With Vercel, run `npm run
db:migrate` against production before or during the next deploy.

## Notes on the sharing model

There's no authentication anywhere in this app, by design — it's meant to
be a simple internal tool. Access is entirely link-based:

- The dashboard (`/`) lists every venue and event. Don't share this link.
- A venue's editor (`/venues/<id>`) is also unshared — only used to lay
  out tables and create events.
- An event's page (`/e/<share-slug>`) is the one link meant for sharing.
  The slug is a long random token (108 bits), not sequential or guessable,
  so sharing it with one collaborator doesn't expose your other events.
  Anyone with the link can view **and edit** that event's seating — there's
  no read-only mode. If that's ever a problem, the natural next step is a
  second, read-only slug per event.

## Not built yet (explicitly deferred)

- **Google Sheets sync** for the guest list — CSV upload/reconcile covers
  the same need today; the user asked for this as a later phase.
- **Fine-grained table reordering** within a section (the venue editor
  moves a table to the end of a different section, but doesn't support
  reordering within one — a minor cosmetic gap, not a functional one).
- **Read-only sharing links**, mentioned above.

## Project structure

```
src/
  app/                    Routes (dashboard, venue editor, event page, print, export)
  components/ui.tsx       Small shared UI primitives (Button, Panel, etc.)
  db/                     Drizzle schema + client
  lib/                    Pure logic: CSV parsing, the assignment engine, reconciliation
                           (all unit-tested, zero database dependency)
  server/                 Server Actions (mutations) + read queries
drizzle/                  Generated SQL migrations
scripts/migrate.mjs       Plain-JS migration runner used by the Docker entrypoint
Dockerfile                Multi-stage build → minimal production image
docker-compose.yml        App + Postgres, for local trial or a simple VPS deploy
docker-compose.prod.yml   Optional overlay: adds Caddy for a domain + automatic HTTPS
```
