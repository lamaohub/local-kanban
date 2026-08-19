# HTTP API & SSE — the official extension point

The board is a plain HTTP server on `http://127.0.0.1:3100`. Everything the UI and the `kb` CLI do goes through this API, so external tools (bots, stats, importers, notifiers) can do the same — as **separate programs running on the same machine**. There are no in-page plugins by design: an external process can't touch the board's DOM or leak its data.

## Trust model

The server binds to **127.0.0.1 only** and has **no authentication**: the local machine is trusted, the network is not. **Do not** expose the port via reverse proxies or port forwarding. Anything that can make HTTP requests on your machine has full access to the board — that is the intended model, same as any local dev tool.

## Conventions

- JSON in/out (`Content-Type: application/json`), except image uploads (raw `image/*` body).
- Tasks are addressed by **key** `PREFIX-N` (e.g. `DEMO-3`, case-insensitive) or numeric id.
- Projects are addressed by **slug** or prefix.
- Errors: `4xx/5xx` with `{ "error": "message" }`.
- Task descriptions may contain raw newlines — use a tolerant JSON parser when piping through a shell.

## Stability contract

**Public (kept backward-compatible):** `/api/tasks*`, `/api/projects` (GET/POST/PATCH), `/api/events` and its event types, `/api/sync` (GET), `/api/stats`.
**Internal (may change without notice):** `/api/dashboard`, `/api/about`, `/api/update-check`, `/api/backups`, `/api/horizons`, wizard helpers (`/api/projects/clone`, `/api/projects/server-git`, `/api/projects/demo`), `/api/sync/*` mutations.

New fields may be added to responses at any time — parse leniently.

## Tasks

| Method & path | Meaning |
|---|---|
| `GET /api/tasks?project=<slug>` | tasks of a project (add `all=1` to include backlog/done/cancelled) |
| `GET /api/tasks/:key` | full task: events timeline, `links`, `attachments`, `checklist`, `commit_url` |
| `POST /api/tasks` | create: `{project, title?, description?, status?, priority?, labels?}` — status only `backlog`/`todo`; `title` optional |
| `PATCH /api/tasks/:key` | update any of title/description/status/priority/labels/pinned/blocked… Transition rules are enforced (e.g. `backlog → done` is rejected; label must be from the palette) |
| `DELETE /api/tasks/:key` | delete task + attachments (closes the GitHub issue if synced) |

**Field naming.** A bare name is always a **collection**, a `_n` suffix is always a **count**.
The task *list* carries `comments_n`, `attachments_n` and `linked_ids` (ids only — enough to draw
the lines on the board); the single-task response carries `links`, `attachments` and `checklist`
as arrays of objects. Nested-route params follow one scheme: `:commentId`, `:attachmentId`,
`:itemId`, `:linkedId`.

| `POST /api/tasks/:key/duplicate` | copy title/description/priority/labels into a new `todo`/`backlog` task |
| `GET/POST /api/tasks/:key/comments` | comments; POST `{body, author?}` or a raw `image/*` body (screenshot) |
| `DELETE /api/tasks/:key/comments/:commentId` | delete a comment (local only) |
| `POST /api/tasks/:key/links` | link tasks: `{key, rel: related\|child\|parent}` |
| `DELETE /api/tasks/:key/links/:linkedId` | unlink |
| `POST /api/tasks/:key/attachments` | raw `image/*` body ≤ 6 MB → stored file, returned with `url` and absolute `path` |
| `GET /api/tasks/:key/attachments` / `DELETE …/:attachmentId` | list / remove |
| `GET/POST/PATCH/DELETE /api/tasks/:key/checklist[/:itemId]` | checklist items `{text, done, position}` |

Statuses: `backlog → todo → prep → doing → deploy → review → done` (+ `cancelled`). Tasks labeled `noclaude` may jump straight from `backlog`/`todo` to `review`/`done`.

## Projects

| Method & path | Meaning |
|---|---|
| `GET /api/projects` | registry with per-status counters |
| `GET /api/projects/:slug` | one project (+ `deploy_skill_path`) |
| `POST /api/projects` | create: `{slug, name, path?, server?, server_path?, pm2_services?, domain?, deploy_skill?, category?, prefix?}` |
| `PATCH /api/projects/:slug` | update the same fields; `archived: 1` hides a project |
| `GET /api/projects/:slug/status` | live service statuses (local pm2 by default, or `PANEL_URL` provider) |
| `GET /api/projects/folders` | folders on disk vs registry: `{root, unregistered, missing}` |
| `POST /api/projects/folders` | mkdir/adopt a folder under `KB_LOCAL_ROOT` as a project |
| `GET /api/projects/:slug/docs` | what Claude reads before working: `{path, path_exists, docs[], skill}` |
| `GET /api/projects/:slug/docs/:name` | the text of one of those documents |

`pm2_services` is stored as a JSON array serialized to a string, e.g. `"[\"my-api\"]"`. On write it
also accepts a comma-separated string (`"my-api, my-bot"`) or a real array and stores the canonical
form; on read, older rows holding a bare string are still parsed, so both forms are safe.

`GET /api/projects/:slug/docs` lists the project's own notes — `CLAUDE.md`, `CLAUDE.local.md`,
`AGENTS.md`, `README.md`, `ARCHITECTURE.md` — with absolute paths, plus the deploy skill the project
uses (`generic: true` when it is the shared `deploy` one). `CLAUDE.md` is listed even when the file
is missing: that absence is information, not an empty answer. The name in `/docs/:name` must be one
of those five — the folder comes from the registry, but a basename from the URL joined onto it would
be a way out of the folder.

### Status provider contract (`PANEL_URL`)

If you point `PANEL_URL` at your own endpoint, return either a bare array or `{"pm2": [...]}` of:

```json
{ "name": "my-api", "status": "online", "uptime": 1720000000000, "restarts": 3, "memory": 52428800, "cpu": 0.4 }
```

`uptime` — ms timestamp of process start; only `name` and `status` are required.

## Skills

Skills are the instruction files Claude reads (`SKILL.md`). They live outside the board, in
`~/.claude/skills` plus any root listed in `KB_SKILLS_EXTRA`.

| Method & path | Meaning |
|---|---|
| `GET /api/skills` | `{roots, board_skill, generic_deploy_skill, items[], board}` — every skill found, with the projects using it |
| `GET /api/skills/:name` | `{name, path, real_path, symlink, exists, size, mtime, text}` |
| `GET /api/skills/:name/upstream?lang=` | the shared version: GitHub first, the copy shipped with the package as a fallback; the response says which (`source`, `lang`) and writes nothing |
| `PUT /api/skills/:name` | `{text, confirm_path}` → writes the file |

`confirm_path` is a lock, not a formality: a skill directory is often a symlink to a file in another
repository, so the client has to echo back the **resolved** path it meant to overwrite (`real_path`).
A mismatch is a `409` naming the real path, not a silent write to the wrong file. The previous
contents are copied into `<data>/backups/skills/` before the write. A name is one path segment
(`[A-Za-z0-9_-]{1,64}`); a check board started from a backup refuses to write skills at all.

## Events (SSE)

`GET /api/events` — `text/event-stream`; each message is `data: {"type": "...", "data": {...}}`.

Types: `task.created`, `task.updated` (includes `prev_status` on real transitions), `task.deleted`, `task.comment`, `task.linked`, `task.attached`, `project.updated`, `sync.status`, `ping` (heartbeat every 30 s — treat a silence longer than ~75 s as a dead connection and reconnect).

## Sync, stats, misc

- `GET /api/sync` — queue state: `{pending, failed, errors, paused, configured, owner, repo, source, last_ok}`. `configured: false` = local-only mode.
- `GET /api/stats` — weekly done/time counters.

## Examples

Next task in the queue, via curl + python (tolerant parsing):

```bash
curl -s 'http://127.0.0.1:3100/api/tasks?project=demo' -o /tmp/t.json
python3 -c "import json; d=json.JSONDecoder(strict=False).decode(open('/tmp/t.json').read()); \
print([t['key'] for t in d if t['status']=='todo'])"
```

A minimal watcher — notify on every task that reaches review:

```js
// node watch.js
const es = new (require('eventsource'))('http://127.0.0.1:3100/api/events');
es.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.type === 'task.updated' && ev.data.status === 'review' && ev.data.prev_status !== 'review') {
    console.log(`ready for review: ${ev.data.key} — ${ev.data.title}`);
  }
};
```

Create a task from a shell script:

```bash
curl -s -X POST http://127.0.0.1:3100/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"project":"demo","title":"from my script","status":"todo","priority":2}'
```

The reference client is [`bin/kb`](../bin/kb) — a zero-dependency Node script covering the whole workflow.
