<img src="docs/images/amethyst_title_1660.jpg" width="100%" alt="Banner">

A light-weight, collaborative, web-based **OWL 2** ontology editor for non-experts, with built-in authentication, multi-project workspaces, per-ontology branching with merge, GitHub integration, SPARQL, an interactive graph view, an AI assistant, and other tools.

If you’re using Amethyst, please ★ this repository to show your interest!

## Features

<img align="right" width="45%" src="docs/images/landscape.png" alt="Semantic Landscape">

- **OWL 2 authoring** — classes, object/datatype/annotation properties, named individuals, subclass hierarchies, domains/ranges, custom datatypes, and SWRL rules (with 60+ built-in predicates).
- **Multi-project workspace** — organise ontologies into projects; open several at once with one designated write target. Sibling ontologies surface as read-only linked context in lists and the graph.
- **Branching, merge & conflict resolution** — branch any ontology, edit independently, then merge back with `ours`/`theirs` conflict resolution.
- **Interactive graph** — Cytoscape.js with five layouts (vertical tree, horizontal tree, force-directed, concentric, grid). Live text search, edge filters (hierarchy / relationships / both), and export to PNG, JPEG, JSON, or Markdown.
- **SPARQL 1.1** — query and update console backed by Oxigraph, scoped per-user, with result tables and sample queries.
- **Import/export** — accepts `.ttl`, `.nt`, `.nq`, `.trig`, `.rdf`, and `.jsonld`. Import from file upload, URL, or GitHub. Automatically chases `owl:imports` and adds referenced ontologies. Export in any of those formats.
- **Authentication** — built-in email/password, Google OAuth, and GitHub OAuth (or Personal Access Token) for repo + discussions integration. First registered user becomes admin.
- **GitHub integration** — link a project to a repo to sync `.ttl` files, push branches, open pull requests, browse issues, and cross-post comments to GitHub Discussions.
- **AI assistant** — ontology-aware streaming chat powered by GitHub Models; choose from GPT-4o, Llama, Mistral, Phi-4, and more. Requires a connected GitHub token.
- **Roles & invites** — global admin/user roles plus per-project manager / editor / viewer roles. Invite collaborators by email (SMTP) or shareable link.
- **Comments & audit trail** — threaded comments on any entity, dedicated discussions feed, and a full audit log of every change (who, what, when) visible to admins.
- **Terminology toggle** — switch the UI between standard RDF/OWL labels and LPG-friendly business terms.
- **Storage choice** — embedded SQLite by default, PostgreSQL for production; optional Litestream replication of SQLite to GCS or S3.
- **Single container** — Node + React + Oxigraph + SQLite all in one image; PostgreSQL is the only external service when you opt in.

## Screenshots

![Graph](docs/images/graph-view.png)
![Entities](docs/images/class-view.png)
![Relationships](docs/images/object-view.png)
![Projects](docs/images/project-view.png)

<!-- More examples:
![Alt text](docs/images/file.png)
![Sized image](docs/images/file.png "Hover title")
<img src="docs/images/file.png" alt="Alt" width="600"> -->

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Single Node container                               │
│                                                      │
│   React (Vite build) ──┐                             │
│                        │  served by                  │
│   Express (/api/*) ────┤  Express                    │
│     ├── auth/          │                             │
│     ├── projects/      │  (incl. github/*)           │
│     ├── ontologies/    │  (branch / merge / diff)    │
│     ├── sparql/        │                             │
│     ├── graph/         │                             │
│     ├── import/        │                             │
│     ├── comments/      │                             │
│     ├── rules/         │  (SWRL)                     │
│     ├── ai/            │  (GitHub Models)            │
│     ├── invites/       │                             │
│     └── admin/         │                             │
│        │               ▼                             │
│        ▼          Oxigraph (in-memory, SPARQL 1.1)   │
│   SQLite or PostgreSQL                               │
│   (users, sessions, projects, audit log, comments)   │
│                                                      │
│   data/                                              │
│     ├── app.sqlite        ← users + projects + log   │
│     ├── sessions.sqlite   ← express sessions         │
│     ├── ontologies/       ← one .ttl per ontology    │
│     └── branches/         ← branch snapshots         │
└──────────────────────────────────────────────────────┘
```

Oxigraph runs **in-process** via its WASM Node bindings: SPARQL 1.1 queries and updates with zero external services. Each ontology lives in its own named graph (`urn:ontology-editor:onto:<id>`) so workspace queries can union across selected ontologies while keeping isolation between projects.

## Quick start — Docker

The whole thing is one container. You only need Docker.

```bash
docker compose up
```

Open http://localhost:3000 — the first account you register becomes admin.

Data persists in the named volume `amethyst`. To start fresh:

```bash
docker compose down -v
```

Override the session secret for production:

```bash
SESSION_SECRET="some-long-random-string" docker compose up -d
```

## Local build (Docker)

```bash
docker compose up --build
```

## Local development (no Docker)

Prerequisites: **Node 20+** (the Docker image uses Node 25).

```bash
# install deps for root, server, client
npm run install:all

# run server (:3000) and Vite dev server (:5173) together with hot reload
npm run dev
```

Open http://localhost:5173 — Vite proxies `/api` to the Node server on 3000.

To run a production build locally (single port, no Vite):

```bash
npm run build          # builds client/dist
npm start              # serves client + API from :3000
```

### Local data

Everything lives in `./data/`:

- `app.sqlite` — users, projects, comments, audit log
- `sessions.sqlite` — login sessions
- `ontologies/<id>.ttl` — one Turtle file per ontology
- `branches/` — branch snapshots used for merge/diff

Delete the folder to start from scratch.

## Importing an existing ontology

1. Sign in.
2. Go to **Import / Export** in the sidebar.
3. Drop in a `.ttl`, `.nt`, `.nq`, `.trig`, `.rdf`, or `.jsonld` file — or paste a URL. Choose whether to merge into the current ontology, add it as a new ontology, or seed a new project.
4. Any `owl:imports` references are followed automatically and added as sibling ontologies (failures are reported as warnings).
5. Open the **Graph** view to see your classes, individuals, and their relationships.

There is a sample ontology at `examples/pizza.ttl` you can use as a starting point.

You can also import via the API:

```bash
curl -b cookies.txt -c cookies.txt -X POST \
  -H "X-Requested-With: XMLHttpRequest" \
  -F file=@pizza.ttl -F replace=true \
  http://localhost:3000/api/import/file
```

## API

All endpoints require an authenticated session (cookie-based) and state-changing requests must include the `X-Requested-With` header. The table below summarises the route families; see `server/src/routes/` for the full set.

| Path | Purpose |
| --- | --- |
| `/api/auth/*` | Register, login, logout, current user, user roster, Google OAuth, GitHub OAuth/PAT |
| `/api/projects/*` | CRUD projects, members, project roles, invites |
| `/api/projects/:id/github/*` | Link/sync repo, branches, push, open PRs, issues, discussions sync |
| `/api/ontologies/*` | CRUD ontologies, branch, merge, resolve conflicts, diff, history |
| `/api/sparql/*` | SPARQL 1.1 query and update |
| `/api/graph` | Cytoscape-friendly graph JSON (`?mode=classes\|individuals\|full`) |
| `/api/import/*` | Import from file, URL, or GitHub; resolve `owl:imports` |
| `/api/comments/*` | Threaded comments on ontologies or specific entity IRIs |
| `/api/rules/*` | CRUD SWRL rules |
| `/api/ai/*` | List available LLMs; streaming chat (GitHub Models) |
| `/api/admin/*` | System info, audit log, registration toggle, user role management |
| `/api/invites/*` | Server-level invite management |
| `/api/health` | Liveness probe used by the Docker healthcheck |

## Environment variables

### Core

| Var              | Default                                 | Purpose                                            |
| ---------------- | --------------------------------------- | -------------------------------------------------- |
| `PORT`           | `3000`                                  | HTTP port                                          |
| `NODE_ENV`       | `development`                           | Standard Node env                                  |
| `DATA_DIR`       | `./data` (local) / `/app/data` (Docker) | Where ontology Turtle files (and SQLite, by default) live |
| `SESSION_SECRET` | `change-me-in-production`               | Cookie signing secret — **set this in production** |
| `COOKIE_SECURE`  | `true` in prod, `false` in dev          | Set to `false` for plain-HTTP deployments with no TLS proxy |
| `CORS_ORIGIN`    | _(none in prod, localhost:5173 in dev)_ | Comma-separated allowed origins for cross-origin requests |
| `APP_BASE_URL`   | derived from request                    | Public base URL (set when behind a TLS-terminating proxy) so invite links and OAuth callbacks use the right scheme/host |

### Database

| Var            | Default                                          | Purpose                                                                                  |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL` | _(unset → SQLite)_                               | PostgreSQL connection string. When set, Postgres is used in place of SQLite.             |
| `SQLITE_DIR`   | `DATA_DIR` (or `/tmp` when Litestream is on)     | Where `app.sqlite` and `sessions.sqlite` live. Must be on a real POSIX disk, not FUSE.   |

### Google OAuth

| Var                     | Default                                                | Purpose                                  |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `GOOGLE_CLIENT_ID`      | _(unset)_                                              | Enables "Continue with Google" when set  |
| `GOOGLE_CLIENT_SECRET`  | _(unset)_                                              | Google OAuth client secret               |
| `GOOGLE_CALLBACK_URL`   | `<APP_BASE_URL>/api/auth/google/callback`              | Override behind a reverse proxy          |

### GitHub OAuth

| Var                     | Default                                                | Purpose                                              |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `GITHUB_CLIENT_ID`      | _(unset)_                                              | Enables GitHub connection button when set            |
| `GITHUB_CLIENT_SECRET`  | _(unset)_                                              | GitHub OAuth client secret                           |
| `GITHUB_CALLBACK_URL`   | `<APP_BASE_URL>/api/auth/github/callback`              | Override behind a reverse proxy                      |

### Email / SMTP

If `SMTP_HOST` is unset, invite links are displayed in the UI instead of emailed.

| Var           | Default              | Purpose                              |
| ------------- | -------------------- | ------------------------------------ |
| `SMTP_HOST`   | _(unset)_            | SMTP server hostname                 |
| `SMTP_PORT`   | `587`                | SMTP port (use `465` for SSL)        |
| `SMTP_SECURE` | `false`              | Set `true` to use TLS/SSL (port 465) |
| `SMTP_USER`   | _(unset)_            | SMTP auth username                   |
| `SMTP_PASS`   | _(unset)_            | SMTP auth password                   |
| `SMTP_FROM`   | `SMTP_USER`          | From address for outgoing email      |

### Litestream (optional SQLite backup)

| Var                          | Default     | Purpose                                                                                |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `LITESTREAM_REPLICA_BUCKET`  | _(unset)_   | Object-storage bucket to replicate to. Setting this enables Litestream.                |
| `LITESTREAM_REPLICA_TYPE`    | `gs`        | Backend: `gs` (GCS) or `s3`                                                            |
| `LITESTREAM_REPLICA_REGION`  | _(unset)_   | Required for `s3`                                                                      |
| `LITESTREAM_REPLICA_ENDPOINT`| _(unset)_   | Set only for S3-compatible services (R2, Tigris, MinIO)                                |

### Performance & caching

| Var                       | Default | Purpose                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `QUERY_CACHE_TTL_MS`      | `15000` | How long (ms) server-side SPARQL results are cached                  |
| `QUERY_CACHE_MAX_ENTRIES` | `500`   | Maximum number of cached SPARQL results                              |

### Request timing

| Var               | Default                            | Purpose                                                              |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `TIMING_SLOW_MS`  | `200`                              | Requests slower than this are flagged `⚠ SLOW` in the log            |
| `TIMING_LOG_ALL`  | `true` in dev, `false` in prod     | Log every request (`true`) or only slow ones (`false`)               |

## Database: SQLite vs PostgreSQL

By default the server uses **SQLite** (embedded, zero configuration). This is great for local development and small deployments.

For production cloud deployments — especially those with ephemeral container filesystems (Cloud Run, Fly, ECS) — use **PostgreSQL**. Set `DATABASE_URL` and the server switches automatically; all required tables are created on first startup.

```bash
DATABASE_URL=postgresql://user:pass@host:5432/dbname docker compose up -d
```

Both adapters expose the same interface and the rest of the codebase is database-agnostic.

## Backups with Litestream

If you stick with SQLite in production, you can replicate the two SQLite files to object storage with [Litestream](https://litestream.io). Litestream is pre-installed in the Docker image and wired through `docker-entrypoint.sh` / `litestream.yml`.

To enable it, set at minimum:

```bash
LITESTREAM_REPLICA_BUCKET=my-bucket
LITESTREAM_REPLICA_TYPE=gs        # or s3
```

When enabled, on startup the container:

1. Restores `app.sqlite` and `sessions.sqlite` from the bucket if a replica exists.
2. Wraps the Node process in `litestream replicate`, streaming changes back to the bucket continuously.

`SQLITE_DIR` defaults to `/tmp` (tmpfs) when Litestream is on — durability comes from replication, not the volume — and back to `DATA_DIR` when it is off. You can override it explicitly.

Auth: GCS uses the standard service-account / workload-identity flow (`GOOGLE_APPLICATION_CREDENTIALS` if needed); S3 uses `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

Only the SQLite files are replicated. Ontology Turtle files in `DATA_DIR/ontologies/` should sit on a persistent volume or FUSE-mounted bucket (GCSFuse / s3fs).

## License

[MIT](LICENSE)
