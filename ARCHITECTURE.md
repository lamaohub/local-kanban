# Architecture

How the board is built, for people changing its code. How to *use* the board is in
[README.md](README.md); the HTTP contract for external tools is in [docs/API.md](docs/API.md).

## Design constraints

These are deliberate and predate most of the features. Changes that break them need a good reason.

- **Local-first.** One SQLite file on one machine. The server binds `127.0.0.1` and has no auth —
  the machine is the trust boundary. GitHub sync is optional and off until configured.
- **No build step.** The frontend is vanilla ES modules served straight from `public/`. Edit a
  file, reload the page. No bundler, no transpiler, no framework.
- **Three runtime dependencies** — Fastify, better-sqlite3, `@fastify/static`. Everything else is
  the Node standard library. Adding a fourth is a decision, not a detail.
- **Synchronous database access.** better-sqlite3 is sync by design; route handlers read and write
  the DB directly, with no connection pool or async layer to reason about.
- **Token-efficient CLI.** `kb` exists so an AI agent can drive the board with one line of output
  per action instead of scraping a web page. Terse output is a feature.

## Layout

| Path | Responsibility |
|---|---|
| `src/server.js` | app composition: static mounts, origin guard, error handler, listen |
| `src/config.js` | the only place environment variables are read |
| `src/db.js` | opens the DB, runs migrations, exposes `db` and small kv/queue helpers |
| `src/schema.sql` | DDL for a fresh install, replayed on every start (`CREATE TABLE IF NOT EXISTS`) |
| `src/origin-guard.js` | rejects cross-origin and unexpected `Host` requests |
| `src/bus.js` | in-process event bus + SSE connection ceiling |
| `src/routes/tasks.js` | tasks, comments, checklists, attachments, links |
| `src/routes/projects.js` | project registry, folders, categories, service status |
| `src/routes/dashboard.js` | aggregate queries behind `/api/stats` and `/api/dashboard` |
| `src/routes/system.js` | labels, sync config, error log, backups, about/update |
| `src/routes/events.js` | the SSE stream |
| `src/routes/horizons.js` | time-horizon goals |
| `src/sync/github.js` | every `gh` invocation, the label palette, Projects v2 plumbing |
| `src/sync/worker.js` | drains the sync queue in the background |
| `src/backup.js`, `src/restore.js` | scheduled snapshots; opening a backup as a second board |
| `src/task-shape.js` | one canonical shape for a task event, shared by routes and worker |
| `public/app.js`, `public/js/*.js` | frontend entry point plus eleven modules split by feature |
| `bin/local-kanban` | install wizard and `start` subcommand |
| `bin/kb` | the CLI; speaks HTTP to the board, no shared code with the server |
| `test/` | `node --test`, no test framework |

## Data

The database lives in `kanban.db` inside the data directory. The data directory is resolved in
`src/config.js`, in this order:

1. `KB_DATA_DIR` if set — explicit wins;
2. `<code>/data` if it already contains a `kanban.db` — a working install is never relocated;
3. `~/.local-kanban` when the code sits inside `node_modules` — an npm install must not keep its
   data inside a directory the package manager recreates on update;
4. `<code>/data` otherwise — a git clone.

Attachments and backups are subdirectories of the same data directory, never of the code
directory. Anything that writes user data resolves its path from `DATA_DIR`.

**Migrations** are versioned through `PRAGMA user_version`: an ordered array of steps in
`src/db.js`, each run once. `schema.sql` runs on every start *after* migrations, so new tables
reach old databases on their own; new *columns* on existing tables need a migration step. A
snapshot is written before any migration runs.

## Status model

```
backlog → todo → prep → doing → deploy → review → done        (+ cancelled)
```

The statuses model an agent's working loop, not a generic board. `prep` is study-before-code;
`doing` and `deploy` are the only statuses where the work timer runs.

Rules worth knowing before touching them:

- **Tasks may only be created in `backlog` or `todo`.** The server rejects anything else with 400.
  A task that appears directly in `done` is a phantom in the statistics with an open issue behind it.
- **`backlog`/`todo` → `review`/`done` is rejected** — work has to pass through the working
  statuses. The exception is tasks labelled `noclaude` (done by hand), checked on both sides.
- `prep`/`doing`/`deploy` are read-only in the UI: those columns are moved by the CLI. The server
  does not forbid it — `kb` uses the same API.
- Frontend move rules live in **one** function, `moveBlocked(from, to, …)`. Every surface that can
  move a task — drag, drop, the drawer select, keyboard shortcuts, the context menu, group actions
  — asks it. Adding a surface means calling it, not reimplementing the rules.
- Every transition appends a row to `task_events`. The drawer timeline is built from that log, so
  a task that bounced between statuses shows its real history.

Changing the set of statuses means changing, in the same commit: the `CHECK` in `schema.sql`, a
migration in `db.js`, `GH_STATUS` in `sync/github.js`, the aliases in `bin/kb`, `ALL_STATUSES` on
the frontend, and the CLI skill documentation.

## API naming contract

One rule, visible to every external consumer: **a bare name is a collection, an `_n` suffix is a
count.** The task list returns `comments_n`, `attachments_n`, `linked_ids`; a single task returns
`links`, `attachments`, `checklist` as arrays of objects. Nested route parameters follow
`:<entity>Id`. Tests assert both that the new names exist and that the old ones do not.

New field or route: follow the rule and write it down in `docs/API.md`, which is what an external
integrator reads.

## Frontend

`public/app.js` is the entry point; feature modules live in `public/js/`. Because they are ES
modules, nothing lands on `window` implicitly — `app.js` assigns an explicit list of functions for
console use and browser-driven tests. A function that a test needs must be added to that list
rather than reached around.

SSE updates are applied **surgically**: `applySseEvent` patches the affected card for
`task.created/updated/deleted` instead of re-fetching the board. A full refresh is the fallback for
events that change structure.

`localStorage` keys are namespaced (`kb.set.*`, `kb.ui.*`, `kb.chaos.*`, `kb.session.*`). Renaming
a key silently loses whatever the user had saved, so a rename ships with a one-time value migration.

## GitHub sync

Optional, one-directional (board → GitHub), and invisible to the agent: it costs no tokens because
it runs in a background worker, not in the request path.

- Target `owner`/`repo` are configuration (env or the settings UI), never hardcoded, and validated
  strictly before use.
- Tasks become issues; projects become Projects v2 boards, created lazily. Status columns are
  created in the board's language, and the name→status map understands both locales plus GitHub's
  own defaults, so a renamed column still resolves.
- The queue payload is a **snapshot**, so an operation survives deletion of the task it describes.
  It drains FIFO; a failing `create_issue` blocks only the dependent operations of *that* task, not
  the whole queue.
- Labels must exist in the palette in `sync/github.js` — `gh` does not create labels on the fly, and
  a label outside the palette fails on sync forever, retrying the same missing name.

## Tests

`npm test` runs `node --test` over `test/`. There is no test framework and no mocking library. Each
test isolates its database through `KB_DATA_DIR`, so running the suite never touches a real board.

Tests here are mostly **regression guards for behaviour that broke once**: rotation of backups,
queue blocking, move rules, API field names. When you fix something subtle, the test that pins it
down belongs in the same commit.

## Visual conventions

The board is deliberately plain, in the spirit of Linear. **One accent colour** (`--accent`,
brand orange) and a quiet palette of panel/border/muted tokens. All colours come from tokens —
hardcoded hex values are not accepted, because every colour has to work in every theme.

What not to add: multi-coloured strips above blocks, three or four accent colours in one component,
gradient fills, decorative frames. Before adding a visual element, look at how the neighbouring
blocks are built and reuse their language.

## Keeping this document honest

Change the architecture — statuses, queue, schema, endpoints — and update the matching section
here **in the same commit**. While you are in a section, check that what is already written still
describes the living code, and rewrite it if it does not. A stale entry is worse than a missing
one: it sounds authoritative and sends the next reader confidently down a path that no longer
exists.
